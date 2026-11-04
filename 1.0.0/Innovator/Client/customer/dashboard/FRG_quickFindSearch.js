/**
 * Quick Find: settings and filter parsing, query building and ranking. No
 * DOM and no server calls, so it can be tested on its own.
 *
 * Every query is a plain AML get, so the server applies the user's
 * permissions and any Mandatory Access Control policy to it, as to any
 * search. Nothing here reads a table directly.
 *
 * Two queries per ItemType:
 * - prefix: keyed_name starts with the term, ordered by keyed_name, which
 *   every ItemType indexes;
 * - contains: AML `like` conditions on the chosen fields, ordered by
 *   modified_on DESC. That order keeps a search that finds nothing cheap on
 *   large ItemTypes; ordering by an indexed column such as item_number does
 *   not.
 */

const DEFAULT_TYPES = 'Part; Document; CAD';
/**
 * Data types the contains search runs on. Long text (`text`) is left out:
 * searching it is slow on large ItemTypes.
 */
const TEXT_TYPES = new Set(['string', 'sequence', 'ml_string']);
/** Fields tried, in this order, when a type has no field list. */
const DEFAULT_FIELDS = ['keyed_name', 'item_number', 'name'];

export const MIN_CONTAINS_LENGTH = 3;
/** Most ItemTypes searched at once: each one costs two queries per search. */
export const MAX_TYPES = 8;

/**
 * Parses the widget's item_types setting:
 *   "Part: item_number, name; Document; CAD: item_number, name, description"
 * An ItemType without a field list gets the default fields. Duplicates of
 * a type keep the first.
 */
export const parseItemTypesSetting = (value) => {
	const seen = new Set();
	return String(value || DEFAULT_TYPES)
		.split(/[;\n]/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const colon = part.indexOf(':');
			const type = (colon < 0 ? part : part.slice(0, colon)).trim();
			const fields =
				colon < 0
					? null
					: part
							.slice(colon + 1)
							.split(',')
							.map((f) => f.trim().toLowerCase())
							.filter(Boolean);
			return { type, fields: fields && fields.length ? fields : null };
		})
		.filter(({ type }) => type && !seen.has(type) && seen.add(type));
};

/**
 * Turns one ItemType's client metadata into what the queries need, or
 * returns { error } when the ItemType or every listed field is unusable.
 *
 * @param {string} type
 * @param {string[]|null} wanted fields from the settings, or null
 * @param {{instance: string, label: string, icon: string,
 *          props: Map<string, {dataType: string, length: number}>}} meta
 */
export const buildSpec = (type, wanted, meta) => {
	if (!meta || !meta.instance) {
		return { type, error: 'unknown ItemType' };
	}
	const skipped = [];
	const names = wanted || DEFAULT_FIELDS.filter((name) => meta.props.has(name));
	const fields = [];
	for (const name of names) {
		const prop = meta.props.get(name);
		if (!prop || !TEXT_TYPES.has(prop.dataType)) {
			skipped.push(name);
		} else if (!fields.some((f) => f.name === name)) {
			fields.push({ name, dataType: prop.dataType, length: prop.length });
		}
	}
	if (!fields.length) {
		return { type, error: 'no text fields to search', skipped };
	}
	return {
		type,
		// Caches are per ItemType and field list: other fields, other answers.
		key: type + ':' + fields.map((f) => f.name).join(','),
		instance: meta.instance,
		label: meta.label || type,
		icon: meta.icon || '',
		fields,
		skipped
	};
};

// ------------------------------------------------------------ the filter

/**
 * The user's navigation panel (TOC) as the filter shows it: the same
 * folders, in the same order, holding only the entries that open an
 * ItemType search. The server builds the TOC per user, so this is what the
 * user can already reach.
 *
 * `toc` is the panel's data Map (entry key -> entry). A folder entry lists
 * its children's keys in `children`, in display order; an entry with an
 * itemTypeId (and no dashboard) opens a search. `roots` are the top-level
 * keys in order; without them, entries whose parent is not in the map are
 * the roots. `nameOf` turns an ItemType id into its name. Folders left
 * without ItemTypes are dropped.
 *
 * @returns {object[]} nodes: { kind: 'folder', key, label, children } or
 *   { kind: 'type', key, id, name, label }
 */
export const tocTree = (toc, roots, nameOf) => {
	const seen = new Set();
	const visit = (key) => {
		const entry = toc.get(key);
		if (!entry || seen.has(key)) {
			return null;
		}
		seen.add(key);
		if (entry.itemTypeId) {
			const name = entry.dashboard ? '' : nameOf(entry.itemTypeId);
			return name
				? { kind: 'type', key, id: entry.itemTypeId, name, label: entry.label || name }
				: null;
		}
		const children = (Array.isArray(entry.children) ? entry.children : [])
			.map(visit)
			.filter(Boolean);
		return children.length ? { kind: 'folder', key, label: entry.label || key, children } : null;
	};
	const top = roots && roots.length
		? roots
		: [...toc.keys()].filter((key) => !toc.has((toc.get(key) || {})['parent_menu@keyed_name']));
	return top.map(visit).filter(Boolean);
};

/** Every ItemType in a tocTree, once each, in tree order. */
export const tocTypes = (tree) => {
	const byId = new Map();
	const walk = (nodes) => {
		for (const node of nodes) {
			if (node.kind === 'folder') {
				walk(node.children);
			} else if (!byId.has(node.id)) {
				byId.set(node.id, { id: node.id, name: node.name, label: node.label });
			}
		}
	};
	walk(tree);
	return [...byId.values()];
};

/** Names of the ItemTypes anywhere under a node. */
export const typeNamesUnder = (node) =>
	node.kind === 'folder' ? node.children.flatMap(typeNamesUnder) : [node.name];

/**
 * The tree narrowed to a filter text: an ItemType stays when its label or
 * name contains the text; a folder whose label contains it keeps all it
 * holds. Returns the tree itself when the text is empty.
 */
export const filterTree = (tree, text) => {
	const t = normalizeTerm(text);
	if (!t) {
		return tree;
	}
	const hit = (value) => normalizeTerm(value).includes(t);
	const visit = (node) => {
		if (node.kind === 'type') {
			return hit(node.label) || hit(node.name) ? node : null;
		}
		if (hit(node.label)) {
			return node;
		}
		const children = node.children.map(visit).filter(Boolean);
		return children.length ? { ...node, children } : null;
	};
	return tree.map(visit).filter(Boolean);
};

/**
 * The fields the filter offers for one ItemType: its text properties that
 * the contains search can use. The default fields come first, then those
 * shown in the search grid, then the rest; each group by label.
 *
 * @param {{props: Map<string, {dataType: string, label?: string, hidden?: boolean}>}} meta
 * @returns {{name: string, label: string, hidden: boolean}[]}
 */
export const fieldOptions = (meta) => {
	if (!meta || !meta.props) {
		return [];
	}
	const rank = (field) => {
		const index = DEFAULT_FIELDS.indexOf(field.name);
		return index >= 0 ? index : DEFAULT_FIELDS.length + (field.hidden ? 1 : 0);
	};
	return [...meta.props]
		.filter(([, prop]) => TEXT_TYPES.has(prop.dataType))
		.map(([name, prop]) => ({
			name,
			label: prop.label || (name === 'keyed_name' ? 'Keyed Name' : name),
			// keyed_name is hidden in every grid but is a default, so it leads.
			hidden: Boolean(prop.hidden) && !DEFAULT_FIELDS.includes(name)
		}))
		.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
};

/** The fields searched when none are chosen: keyed_name, item_number, name, whichever exist. */
export const defaultFields = (meta) =>
	meta && meta.props ? DEFAULT_FIELDS.filter((name) => meta.props.has(name)) : [];

/**
 * A user's saved filter, from localStorage: { types: [{ id, name, fields }] },
 * where fields null means the defaults. Anything malformed reads as null
 * (no saved filter), so a bad value can never break the widget.
 */
export const parseSavedSelection = (text) => {
	let value;
	try {
		value = JSON.parse(text);
	} catch (ignored) {
		return null;
	}
	if (!value || value.v !== 1 || !Array.isArray(value.types)) {
		return null;
	}
	const types = value.types
		.filter((t) => t && typeof t.name === 'string' && t.name)
		.map((t) => ({
			id: typeof t.id === 'string' ? t.id : '',
			name: t.name,
			fields: Array.isArray(t.fields)
				? t.fields.filter((f) => typeof f === 'string' && f)
				: null
		}))
		.map((t) => (t.fields && !t.fields.length ? { ...t, fields: null } : t));
	return { types: types.slice(0, MAX_TYPES) };
};

export const serializeSelection = (types) =>
	JSON.stringify({
		v: 1,
		types: types.slice(0, MAX_TYPES).map((t) => ({ id: t.id || '', name: t.name, fields: t.fields || null }))
	});

/**
 * The ItemTypes to search: the user's saved filter, or else the widget's
 * item_types setting. When the TOC could be read, a type missing from it is
 * left out (matched by id, or by name for the setting). At most MAX_TYPES.
 *
 * @param {{saved: {types: object[]}|null, setting: string,
 *          toc: {id: string, name: string}[]|null}} input
 * @returns {{type: string, id: string, fields: string[]|null}[]}
 */
export const resolveTypes = ({ saved, setting, toc }) => {
	const known = toc && toc.length ? toc : null;
	const inToc = (id, name) =>
		!known || known.some((t) => (id && t.id === id) || t.name === name);
	const idOf = (name) => {
		const hit = known && known.find((t) => t.name === name);
		return hit ? hit.id : '';
	};
	const list = saved
		? saved.types.map((t) => ({ type: t.name, id: t.id || idOf(t.name), fields: t.fields }))
		: parseItemTypesSetting(setting).map(({ type, fields }) => ({ type, id: idOf(type), fields }));
	return list.filter((t) => inToc(t.id, t.type)).slice(0, MAX_TYPES);
};

/** Trimmed, single-spaced, lower case: the key used for caching and narrowing. */
export const normalizeTerm = (term) =>
	String(term || '')
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase();

export const splitWords = (term) => normalizeTerm(term).split(' ').filter(Boolean);

const xmlText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const xmlAttr = (value) =>
	String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** LIKE wildcards made literal: [ % _ become [[] [%] [_]. */
const likeLiteral = (word) => word.replace(/[[%_]/g, (c) => '[' + c + ']');

/** AML `like` treats * as %; drop it rather than let it act as a wildcard. */
const amlLikeLiteral = (word) => likeLiteral(word.replace(/\*/g, ''));

const SELECT = 'id,keyed_name,config_id,modified_on';

const selectFor = (spec) =>
	[...new Set([...SELECT.split(','), ...spec.fields.map((f) => f.name)])].join(',');

/**
 * Prefix phase: keyed_name starts with the term. Index seek on every
 * ItemType. Returns null when the term is empty.
 */
export const buildPrefixAml = (spec, term, max) => {
	const value = String(term || '')
		.trim()
		.replace(/\s+/g, ' ');
	if (!value) {
		return null;
	}
	return (
		`<Item type="${xmlAttr(spec.type)}" action="get" select="${selectFor(spec)}" ` +
		`maxRecords="${max}" orderBy="keyed_name">` +
		`<keyed_name condition="like">${xmlText(amlLikeLiteral(value))}%</keyed_name>` +
		'<is_current>1</is_current></Item>'
	);
};

/**
 * Contains phase: every word must appear in at least one field, as AML like
 * conditions. Returns null for a term too short to search this way.
 */
export const buildContainsAml = (spec, term, max) => {
	const words = splitWords(term);
	if (!words.length || normalizeTerm(term).length < MIN_CONTAINS_LENGTH) {
		return null;
	}
	const group = (word) => {
		const conditions = spec.fields.map(
			(f) => `<${f.name} condition="like">%${xmlText(amlLikeLiteral(word))}%</${f.name}>`
		);
		return conditions.length > 1 ? `<or>${conditions.join('')}</or>` : conditions[0];
	};
	const body = words.length > 1 ? `<and>${words.map(group).join('')}</and>` : group(words[0]);
	return (
		`<Item type="${xmlAttr(spec.type)}" action="get" select="${selectFor(spec)}" ` +
		`maxRecords="${max}" orderBy="modified_on DESC">${body}<is_current>1</is_current></Item>`
	);
};

/**
 * Rank of one result for the typed term: 0 exact keyed name, 1 keyed name
 * starts with it, 2 some field starts with it, 3 contains.
 */
export const rankOf = (row, term) => {
	const t = normalizeTerm(term);
	const keyed = normalizeTerm(row.keyedName);
	if (keyed === t) {
		return 0;
	}
	if (keyed.startsWith(t)) {
		return 1;
	}
	return Object.values(row.fields || {}).some((v) => normalizeTerm(v).startsWith(t)) ? 2 : 3;
};

/**
 * One ItemType's rows: prefix results, then contains results not already
 * listed, ordered by rank (stable, so each phase keeps the server's order
 * within a rank), at most `max`.
 */
export const mergeRows = (prefixRows, containsRows, term, max) => {
	const seen = new Set();
	const merged = [];
	for (const row of [...(prefixRows || []), ...(containsRows || [])]) {
		if (!seen.has(row.id)) {
			seen.add(row.id);
			merged.push({ row, rank: rankOf(row, term), order: merged.length });
		}
	}
	return merged
		.sort((a, b) => a.rank - b.rank || a.order - b.order)
		.slice(0, max)
		.map((m) => m.row);
};

/**
 * Whether an earlier term that found nothing proves this one finds nothing:
 * for prefix, the new term extends it; for contains, it includes it (then
 * every earlier word is part of a new word, so every new match would have
 * matched the earlier term too).
 */
export const provenEmpty = (phase, term, emptyTerm) => {
	const t = normalizeTerm(term);
	const e = normalizeTerm(emptyTerm);
	return Boolean(e) && (phase === 'prefix' ? t.startsWith(e) : t.includes(e));
};
