/**
 * "QuickFind" - custom Dashboard Widget layout.
 *
 * A search box that finds items by number, name or other text fields across
 * several ItemTypes as the user types, grouped by ItemType. Enter or a click
 * opens the item.
 *
 * Settings (Dashboard Widget Template Props, edited on the widget):
 *   item_types    "Part: item_number, name; Document; CAD": what a user
 *                 searches until they choose for themselves. An ItemType
 *                 without a field list searches keyed_name, item_number and
 *                 name, whichever it has. Fields that are not short text are
 *                 dropped with a console warning.
 *   max_per_type  results shown per ItemType (default 5).
 *
 * The filter button next to the search box lets each user choose, from the
 * ItemTypes in their own navigation panel, which to search (at most
 * MAX_TYPES), and for each one which text fields. The choice is saved in
 * localStorage per database, user and widget; "Use defaults" removes it.
 * ItemTypes in the setting or a saved choice that are not in the user's
 * navigation panel are not searched. That is only a convenience: every
 * query is checked by the server anyway.
 *
 * Per ItemType, each search runs up to two queries in parallel
 * (FRG_quickFindSearch.js):
 *   prefix    keyed_name starts with the term (from 1 character);
 *   contains  every word appears in some configured field (from 3 characters).
 * Both are ordinary AML gets, so the server applies permissions and
 * Mandatory Access Control to them like to any search. The two are merged
 * and ranked: exact keyed name, keyed name prefix, field prefix, contains.
 *
 * Built for large ItemTypes (100k+ rows each):
 * - typing is debounced, and an answer to an older term is dropped;
 * - answers are cached for 30 s, so backspacing costs nothing;
 * - a term that extends one already known to find nothing in an ItemType is
 *   not sent for that ItemType at all (see provenEmpty).
 *
 * The WidgetLayout base class is passed IN rather than imported; see
 * FRG_registerWidgets.js.
 */

import {
	MAX_TYPES,
	MIN_CONTAINS_LENGTH,
	buildContainsAml,
	buildPrefixAml,
	buildSpec,
	defaultFields,
	fieldOptions,
	mergeRows,
	normalizeTerm,
	parseSavedSelection,
	provenEmpty,
	resolveTypes,
	serializeSelection,
	filterTree,
	tocTree,
	tocTypes,
	typeNamesUnder
} from './FRG_quickFindSearch.js';
import { allowFormControls } from './FRG_widgetInput.js';

const STYLE_ELEMENT_ID = 'quick-find-widget-style';
const DEFAULT_MAX = 5;
const DEBOUNCE_MS = 250;
const CACHE_MS = 30000;
const DEFAULT_ICON = '../images/DefaultItemType.svg';

// English only. To translate, replace these with aras.getResource lookups.
const LABELS = {
	placeholder: 'Find items by number or name',
	idle: (types) => 'Searches ' + types,
	idleHint: 'Type a number or a name. Words can be in any order.',
	containsHint: `Type ${MIN_CONTAINS_LENGTH} or more characters to search inside names too.`,
	searching: 'Searching…',
	none: (term) => `No matches for "${term}"`,
	noneHint: 'Check the spelling, or try part of a number or a word.',
	failed: (types) => 'Could not search ' + types,
	noTypes: 'No ItemTypes to search',
	noTypesHint: 'Use the filter button to choose what to search.',
	openHint: (name) => 'Open ' + name,
	filterButton: 'Choose ItemTypes and fields',
	filterSearch: 'Filter ItemTypes',
	selectedTitle: (count) => `Searching · ${count} of ${MAX_TYPES}`,
	selectedNone: 'Nothing selected. Check ItemTypes below.',
	allTitle: 'Your ItemTypes',
	folderCount: (count) => `${count} searched`,
	noMatch: 'No ItemTypes match.',
	noToc: 'Your navigation panel could not be read, so other ItemTypes cannot be listed.',
	atLimit: `Limited to ${MAX_TYPES} ItemTypes for performance.`,
	note: 'Choices are saved in this browser.',
	fields: 'Fields',
	fieldsHidden: 'Not shown in the search grid',
	fieldsUnavailable: 'Fields could not be read.',
	lastField: 'At least one field is searched.',
	useDefaults: 'Use defaults',
	done: 'Done'
};

const FILTER_ICON =
	'<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
	'<path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z"/></svg>';

const CHEVRON_ICON =
	'<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
	'<path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

const STYLES = `
.qfw {
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	font: 400 1rem/1.4 Roboto, 'Noto Sans JP', Arial, sans-serif;
	color: var(--gray900, #4f4f4f);
}
.qfw__bar {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--gray400, #dfdfdf);
}
.qfw__input {
	box-sizing: border-box;
	flex: 1 1 auto;
	min-width: 0;
	width: 100%;
	height: 30px;
	padding: 4px 8px;
	font: inherit;
	color: inherit;
	background: var(--white, #ffffff);
	border: 1px solid var(--gray500, #cfcfcf);
	border-radius: 4px;
	outline: 0;
}
.qfw__input:focus {
	border-color: var(--focus, #0f66cb);
}
.qfw__list:empty {
	display: none;
}
.qfw__list {
	flex: 1 1 auto;
	overflow: auto;
	padding: 4px 0;
	margin: 0;
	list-style: none;
}
.qfw-group__rows {
	margin: 0;
	padding: 0;
	list-style: none;
}
.qfw-group__title {
	padding: 6px 12px 2px;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .04em;
	opacity: .7;
}
.qfw-row__button {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 5px 12px;
	background: transparent;
	border: 0;
	border-left: 3px solid transparent;
	text-align: left;
	cursor: pointer;
	font: inherit;
	color: inherit;
}
.qfw-row__button:hover,
.qfw-row_active .qfw-row__button {
	background-color: var(--gray300, #ebebeb);
}
.qfw-row_active .qfw-row__button {
	border-left-color: var(--focus, #0f66cb);
}
.qfw-row__button:focus {
	outline: 0;
}
.qfw-row__icon {
	height: 1.5rem;
	width: 1.5rem;
	flex-shrink: 0;
	display: block;
}
img.qfw-row__icon {
	object-fit: contain;
}
.qfw-row__text {
	min-width: 0;
	flex: 1 1 auto;
}
.qfw-row__name {
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qfw-row__meta {
	font-size: 11px;
	opacity: .7;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qfw__message {
	flex: 1 1 auto;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	padding: 16px 12px;
	font-size: 12px;
	text-align: center;
}
.qfw__message-title {
	font-size: 13px;
	font-weight: 500;
}
.qfw__message-hint {
	padding-top: 4px;
	opacity: .75;
}
.qfw__footer {
	flex: 0 0 auto;
	padding: 4px 12px;
	font-size: 11px;
	opacity: .7;
	border-top: 1px solid var(--gray400, #dfdfdf);
}
.qfw__footer:empty {
	display: none;
}
.qfw__filter-button {
	flex: 0 0 auto;
	box-sizing: border-box;
	height: 30px;
	min-width: 30px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	padding: 0 7px;
	font: inherit;
	font-size: 12px;
	color: inherit;
	background: var(--white, #ffffff);
	border: 1px solid var(--gray500, #cfcfcf);
	border-radius: 4px;
	cursor: pointer;
}
.qfw__filter-button:hover {
	background-color: var(--gray300, #ebebeb);
}
.qfw__filter-button:focus-visible,
.qfw__filter-button[aria-expanded='true'] {
	outline: 0;
	border-color: var(--focus, #0f66cb);
	color: var(--focus, #0f66cb);
}
.qfw__filter-button svg {
	width: 16px;
	height: 16px;
	fill: currentColor;
}
.qfw_filtering .qfw__list,
.qfw_filtering .qfw__message,
.qfw_filtering .qfw__footer {
	display: none;
}
.qfw-filter {
	flex: 1 1 auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.qfw-filter__head {
	flex: 0 0 auto;
	padding: 8px 12px 2px;
}
.qfw-filter__body {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding-bottom: 8px;
}
.qfw-filter__title {
	padding: 8px 12px 2px;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .04em;
	opacity: .7;
}
.qfw-filter__list,
.qfw-fields {
	margin: 0;
	padding: 0;
	list-style: none;
}
.qfw-filter__empty {
	padding: 4px 12px;
	font-size: 12px;
	opacity: .75;
}
.qfw-pick {
	padding: 0 12px;
}
.qfw-pick__row {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 26px;
}
.qfw-pick__label,
.qfw-fields__label {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	cursor: pointer;
}
.qfw-pick__label {
	flex: 1 1 auto;
}
.qfw-pick__label span,
.qfw-pick__fields span {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qfw-pick__label_disabled {
	cursor: default;
	opacity: .5;
}
.qfw-pick input[type='checkbox'] {
	flex: 0 0 auto;
	margin: 0;
	accent-color: var(--focus, #0f66cb);
}
.qfw-pick__fields {
	flex: 0 1 auto;
	max-width: 55%;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 6px;
	font: inherit;
	font-size: 12px;
	color: inherit;
	background: var(--white, #ffffff);
	border: 1px solid var(--gray500, #cfcfcf);
	border-radius: 4px;
	cursor: pointer;
}
.qfw-pick__fields:focus-visible,
.qfw-pick__fields[aria-expanded='true'] {
	outline: 0;
	border-color: var(--focus, #0f66cb);
}
.qfw-fields {
	margin: 2px 0 6px 24px;
	padding: 4px 8px;
	font-size: 12px;
	background: var(--white, #ffffff);
	border: 1px solid var(--gray400, #dfdfdf);
	border-radius: 4px;
}
.qfw-fields__label {
	min-height: 22px;
}
.qfw-fields__divider {
	padding: 4px 0 2px;
	font-size: 11px;
	opacity: .7;
}
.qfw-folder__head {
	box-sizing: border-box;
	width: 100%;
	min-height: 28px;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 0 12px;
	font: inherit;
	font-weight: 500;
	color: inherit;
	text-align: left;
	background: transparent;
	border: 0;
}
button.qfw-folder__head {
	cursor: pointer;
}
button.qfw-folder__head:hover {
	background-color: var(--gray300, #ebebeb);
}
button.qfw-folder__head:focus-visible {
	outline: 1px solid var(--focus, #0f66cb);
	outline-offset: -1px;
}
.qfw-folder__chevron {
	flex: 0 0 auto;
	width: 16px;
	height: 16px;
	transition: transform .12s ease;
}
.qfw-folder__chevron svg {
	display: block;
	width: 16px;
	height: 16px;
}
.qfw-folder__chevron_open {
	transform: rotate(90deg);
}
.qfw-folder__label {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qfw-folder__count {
	flex: 0 0 auto;
	min-width: 18px;
	padding: 0 5px;
	font-size: 11px;
	line-height: 18px;
	text-align: center;
	color: #ffffff;
	background: var(--focus, #0f66cb);
	border-radius: 9px;
}
.qfw-filter__foot {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 12px;
	border-top: 1px solid var(--gray400, #dfdfdf);
}
.qfw-filter__note {
	flex: 1 1 auto;
	min-width: 0;
	font-size: 11px;
	opacity: .7;
}
.qfw-filter__link,
.qfw-filter__done {
	flex: 0 0 auto;
	font: inherit;
	font-size: 12px;
	border-radius: 4px;
	cursor: pointer;
}
.qfw-filter__link {
	padding: 3px 6px;
	color: var(--focus, #0f66cb);
	background: none;
	border: 0;
}
.qfw-filter__done {
	height: 26px;
	padding: 0 14px;
	color: #ffffff;
	background: var(--focus, #0f66cb);
	border: 0;
}
`;

const injectStyles = () => {
	if (document.getElementById(STYLE_ELEMENT_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = STYLES;
	document.head.appendChild(style);
};

const toPositiveInt = (value, fallback) => {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Client-cached ItemType metadata, in the shape buildSpec takes. */
const readMeta = (type) => {
	try {
		const node = aras.getItemTypeNodeForClient(type);
		if (!node) {
			return null;
		}
		const props = new Map();
		for (const prop of Array.from(node.selectNodes("Relationships/Item[@type='Property']"))) {
			props.set(aras.getItemProperty(prop, 'name'), {
				dataType: aras.getItemProperty(prop, 'data_type'),
				length: parseInt(aras.getItemProperty(prop, 'stored_length'), 10) || 0,
				label: aras.getItemProperty(prop, 'label'),
				hidden: aras.getItemProperty(prop, 'is_hidden') === '1'
			});
		}
		return {
			instance: aras.getItemProperty(node, 'instance_data'),
			label: aras.getItemProperty(node, 'label') || type,
			icon: aras.getItemProperty(node, 'open_icon') || '',
			props
		};
	} catch (ignored) {
		return null;
	}
};

/** faultcode of a rejected ArasModules.soap call, or null for a transport failure. */
const faultOf = (error) => {
	if (typeof XMLHttpRequest === 'undefined' || !(error instanceof XMLHttpRequest)) {
		return null;
	}
	try {
		const doc =
			error.responseXML || new DOMParser().parseFromString(error.responseText || '', 'text/xml');
		const code = doc && doc.getElementsByTagName('faultcode')[0];
		return code ? code.textContent.trim() : null;
	} catch (ignored) {
		return null;
	}
};

const NO_ITEMS_FAULT = '0';

const parseRows = (result, spec) =>
	Array.from(result.getElementsByTagName('Item'))
		.filter((item) => item.getAttribute('type') === spec.type || !item.getAttribute('type'))
		.filter((item) => item.parentNode && item.parentNode.nodeName === 'Result')
		.map((item) => {
			const text = (name) => {
				const node = Array.from(item.childNodes).find((n) => n.nodeName === name);
				return node ? node.textContent : '';
			};
			const fields = {};
			spec.fields.forEach((f) => {
				fields[f.name] = text(f.name);
			});
			return {
				id: item.getAttribute('id'),
				type: spec.type,
				keyedName: text('keyed_name') || item.getAttribute('id'),
				fields
			};
		});

/**
 * The user's navigation panel as { tree, types } (see tocTree), or null
 * when it can't be read (not built yet, or a release that keeps it
 * elsewhere). The panel is <aras-navigation-panel> on the main window; its
 * `nav` tree holds the TOC entries in `data` and the top-level keys, in
 * order, in `dataStore.roots` (checked on 14.0.25 and 14.35). Names come
 * from the client's ItemType cache, without a request.
 */
const readToc = () => {
	try {
		const panel = aras.getMainWindow().document.querySelector('aras-navigation-panel');
		const nav = panel && panel.nav;
		const data = nav && nav.data;
		if (!data || typeof data.get !== 'function' || !data.size) {
			return null;
		}
		const roots = nav.dataStore && nav.dataStore.roots ? [...nav.dataStore.roots] : null;
		const tree = tocTree(data, roots, (id) => {
			try {
				return aras.getItemTypeName(id) || '';
			} catch (ignored) {
				return '';
			}
		});
		const types = tocTypes(tree);
		return types.length ? { tree, types } : null;
	} catch (ignored) {
		return null;
	}
};

// ------------------------------------------------------------ saved filter
// Kept in localStorage per database, user and widget, as the Favorites Type
// filter is: the widget part of the key is the Dashboard Widget
// relationship id on the wrapper (data-id), the only id that is stable.
const SELECTION_STORAGE_PREFIX = 'FRG.QuickFind.selection';

const selectionStorageKey = (dom) => {
	const wrapper = dom && dom.closest ? dom.closest('aras-dashboard-widget') : null;
	const widgetId = wrapper ? wrapper.dataset.id : '';
	if (!widgetId || typeof aras === 'undefined') {
		return null;
	}
	const database = aras.getDatabase ? aras.getDatabase() : '';
	const userId = aras.getUserID ? aras.getUserID() : '';
	return userId ? `${SELECTION_STORAGE_PREFIX}.${database}.${userId}.${widgetId}` : null;
};

// localStorage can throw (storage disabled, quota); a lost choice is fine.
const readStored = (key) => {
	try {
		return (key && localStorage.getItem(key)) || null;
	} catch (ignored) {
		return null;
	}
};

const writeStored = (key, value) => {
	if (!key) {
		return;
	}
	try {
		if (value) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch (ignored) {
		// Not saved; the choice still applies until the page reloads.
	}
};

export default function createQuickFindLayout(WidgetLayout) {
	return class QuickFindCuiLayout extends WidgetLayout {
		#root = null;
		#input = null;
		#list = null;
		#footer = null;
		#specs = null;
		#specsKey = null;
		#token = 0;
		#timer = null;
		#term = '';
		// type -> { prefix, contains } rows, undefined while pending, plus error
		#results = new Map();
		// `${type}\n${phase}\n${term}` -> { rows, at }
		#cache = new Map();
		// `${type}\n${phase}` -> [{ term, at }]
		#emptyTerms = new Map();
		#flat = [];
		#activeId = null;
		#filterButton = null;
		// The user's navigation-panel ItemTypes, or null until it can be read.
		#toc = null;
		// Saved filter: undefined until read, null when there is none.
		#saved = undefined;
		#storageKeyValue = null;
		// The filter panel while open: { draft, dirty, expanded, text, body }.
		#filter = null;

		async init() {
			await super.init();
			injectStyles();
			this.#buildDom();
			this.#render();
		}

		/** Settings changed: re-read them and repeat the current search. */
		updateLayout() {
			this.#specs = null;
			this.#searchNow();
		}

		/** Enables "Refresh" in the widget menu: forget every cached answer. */
		async refreshData() {
			this.#cache.clear();
			this.#emptyTerms.clear();
			this.#specs = null;
			this.#toc = null;
			this.#searchNow();
		}

		// ------------------------------------------------------------- settings

		#max() {
			return toPositiveInt(this.state && this.state.max_per_type, DEFAULT_MAX);
		}

		/** The navigation panel's ItemTypes, once each, or null. */
		#tocList() {
			if (!this.#toc) {
				this.#toc = readToc();
			}
			return this.#toc ? this.#toc.types : null;
		}

		// Resolved on first use: the wrapper may not hold the node at first.
		#storageKey() {
			if (!this.#storageKeyValue) {
				this.#storageKeyValue = selectionStorageKey(this.dom);
			}
			return this.#storageKeyValue;
		}

		#savedSelection() {
			if (this.#saved === undefined) {
				const key = this.#storageKey();
				if (!key) {
					return null;
				}
				this.#saved = parseSavedSelection(readStored(key));
			}
			return this.#saved;
		}

		/** What is searched: the saved filter, or the setting, limited to the TOC. */
		#resolved() {
			return resolveTypes({
				saved: this.#savedSelection(),
				setting: String((this.state && this.state.item_types) || ''),
				toc: this.#tocList()
			});
		}

		#getSpecs() {
			const saved = this.#savedSelection();
			const toc = this.#tocList();
			const key = [
				String((this.state && this.state.item_types) || ''),
				saved ? serializeSelection(saved.types) : '-',
				toc ? toc.length : 'x'
			].join('\n');
			if (this.#specs && this.#specsKey === key) {
				return this.#specs;
			}
			this.#specsKey = key;
			this.#specs = this.#resolved()
				.map(({ type, fields }) => {
					const spec = buildSpec(type, fields, readMeta(type));
					if (spec.error) {
						console.warn(`[QuickFind] ${type} left out: ${spec.error}`, spec.skipped || '');
					} else if (spec.skipped.length) {
						console.warn(`[QuickFind] ${type}: fields left out (missing, long text or not text):`, spec.skipped);
					}
					return spec;
				})
				.filter((spec) => !spec.error);
			return this.#specs;
		}

		// --------------------------------------------------------------- search

		#onInput() {
			clearTimeout(this.#timer);
			this.#timer = setTimeout(() => this.#searchNow(), DEBOUNCE_MS);
		}

		#searchNow() {
			clearTimeout(this.#timer);
			this.#timer = null;
			const term = this.#input ? this.#input.value : '';
			const token = ++this.#token;
			this.#term = term;
			this.#activeId = null;
			const specs = this.#getSpecs();
			this.#results = new Map(
				specs.map((spec) => [spec.key, { prefix: undefined, contains: undefined, error: null }])
			);
			if (!normalizeTerm(term)) {
				this.#results.clear();
				this.#render();
				return;
			}
			const max = this.#max();
			for (const spec of specs) {
				for (const phase of ['prefix', 'contains']) {
					this.#runPhase(spec, phase, term, max, token);
				}
			}
			this.#render();
		}

		async #runPhase(spec, phase, term, max, token) {
			const norm = normalizeTerm(term);
			const key = `${spec.key}\n${phase}\n${norm}`;
			let rows = null;
			let error = null;
			const cached = this.#cache.get(key);
			if (cached && Date.now() - cached.at < CACHE_MS) {
				rows = cached.rows;
			} else if (this.#isProvenEmpty(spec.key, phase, norm)) {
				rows = [];
			} else {
				const built =
					phase === 'prefix'
						? buildPrefixAml(spec, term, max)
						: buildContainsAml(spec, term, max);
				if (!built) {
					rows = [];
				} else {
					try {
						rows = await this.#query(built, spec);
					} catch (ex) {
						error = ex;
					}
					if (rows) {
						this.#cache.set(key, { rows, at: Date.now() });
						if (!rows.length) {
							this.#rememberEmpty(spec.key, phase, norm);
						}
					}
				}
			}
			if (this.destroyed || token !== this.#token) {
				return;
			}
			const state = this.#results.get(spec.key);
			if (!state) {
				return;
			}
			if (error) {
				console.warn(`[QuickFind] ${spec.type} ${phase} search failed`, error);
				state.error = error;
				rows = [];
			}
			state[phase] = rows;
			this.#render();
		}

		/** Resolves with the rows, [] for "no items"; rejects on any other failure. */
		async #query(aml, spec) {
			try {
				const result = await ArasModules.soap(aml, {
					method: 'ApplyItem',
					async: true,
					headers: aras.getHttpHeadersForSoapMessage('ApplyItem'),
					url: aras.getServerURL()
				});
				return parseRows(result, spec);
			} catch (ex) {
				if (faultOf(ex) === NO_ITEMS_FAULT) {
					return [];
				}
				throw ex;
			}
		}

		#isProvenEmpty(specKey, phase, norm) {
			const list = this.#emptyTerms.get(`${specKey}\n${phase}`) || [];
			const now = Date.now();
			return list.some((e) => now - e.at < CACHE_MS && provenEmpty(phase, norm, e.term));
		}

		#rememberEmpty(specKey, phase, norm) {
			const key = `${specKey}\n${phase}`;
			const now = Date.now();
			const list = (this.#emptyTerms.get(key) || []).filter((e) => now - e.at < CACHE_MS);
			list.push({ term: norm, at: now });
			this.#emptyTerms.set(key, list.slice(-20));
		}

		// ------------------------------------------------------------ rendering

		#buildDom() {
			const root = document.createElement('div');
			root.className = 'qfw';
			allowFormControls(root);

			const bar = document.createElement('div');
			bar.className = 'qfw__bar';
			const input = document.createElement('input');
			input.type = 'search';
			input.className = 'qfw__input';
			input.placeholder = LABELS.placeholder;
			input.setAttribute('aria-label', LABELS.placeholder);
			input.autocomplete = 'off';
			input.spellcheck = false;
			input.addEventListener('input', () => this.#onInput());
			input.addEventListener('keydown', (event) => this.#onKeyDown(event));
			// Back to the results as soon as the user goes back to typing.
			input.addEventListener('focus', () => this.#closeFilter());

			const filterButton = document.createElement('button');
			filterButton.type = 'button';
			filterButton.className = 'qfw__filter-button';
			filterButton.title = LABELS.filterButton;
			filterButton.setAttribute('aria-label', LABELS.filterButton);
			filterButton.setAttribute('aria-expanded', 'false');
			filterButton.addEventListener('click', () =>
				this.#filter ? this.#closeFilter({ focus: true }) : this.#openFilter()
			);
			bar.append(input, filterButton);
			this.#filterButton = filterButton;

			const list = document.createElement('ul');
			list.className = 'qfw__list';
			list.addEventListener('click', (event) => {
				const row = event.target.closest('.qfw-row');
				if (row) {
					this.#open(row.dataset.type, row.dataset.id);
				}
			});

			const footer = document.createElement('div');
			footer.className = 'qfw__footer';

			root.append(bar, list, footer);
			this.dom.textContent = '';
			this.dom.appendChild(root);
			this.#root = root;
			this.#input = input;
			this.#list = list;
			this.#footer = footer;
		}

		#render() {
			if (!this.#list) {
				return;
			}
			const specs = this.#getSpecs();
			const term = this.#term.trim();
			this.#renderFilterButton(specs.length);
			this.#removeMessage();
			this.#list.textContent = '';
			this.#footer.textContent = '';
			this.#flat = [];

			if (!specs.length) {
				this.#renderMessage(LABELS.noTypes, LABELS.noTypesHint);
				return;
			}
			if (!normalizeTerm(term)) {
				this.#renderMessage(LABELS.idle(specs.map((s) => s.label).join(', ')), LABELS.idleHint);
				return;
			}

			const max = this.#max();
			let pending = false;
			const failed = [];
			for (const spec of specs) {
				const state = this.#results.get(spec.key);
				if (!state) {
					continue;
				}
				pending = pending || state.prefix === undefined || state.contains === undefined;
				if (state.error) {
					failed.push(spec.label);
				}
				const rows = mergeRows(state.prefix, state.contains, term, max);
				if (rows.length) {
					this.#list.appendChild(this.#buildGroup(spec, rows));
				}
			}

			if (!this.#flat.length) {
				if (pending) {
					this.#renderMessage(LABELS.searching, '');
				} else if (failed.length) {
					this.#renderMessage(LABELS.failed(failed.join(', ')), '');
				} else {
					this.#renderMessage(
						LABELS.none(term),
						normalizeTerm(term).length < MIN_CONTAINS_LENGTH ? LABELS.containsHint : LABELS.noneHint
					);
				}
				return;
			}
			const notes = [];
			if (pending) {
				notes.push(LABELS.searching);
			}
			if (failed.length) {
				notes.push(LABELS.failed(failed.join(', ')));
			}
			if (!pending && normalizeTerm(term).length < MIN_CONTAINS_LENGTH) {
				notes.push(LABELS.containsHint);
			}
			this.#footer.textContent = notes.join(' · ');
			this.#highlightActive();
		}

		#buildGroup(spec, rows) {
			const group = document.createElement('li');
			group.className = 'qfw-group';
			const title = document.createElement('div');
			title.className = 'qfw-group__title';
			title.textContent = spec.label;
			const list = document.createElement('ul');
			list.className = 'qfw-group__rows';
			rows.forEach((row) => list.appendChild(this.#buildRow(spec, row)));
			group.append(title, list);
			return group;
		}

		#buildRow(spec, row) {
			this.#flat.push(row);
			const item = document.createElement('li');
			item.className = 'qfw-row';
			item.dataset.id = row.id;
			item.dataset.type = spec.type;

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'qfw-row__button';
			button.tabIndex = -1;
			button.title = LABELS.openHint(row.keyedName);

			const text = document.createElement('div');
			text.className = 'qfw-row__text';
			const name = document.createElement('div');
			name.className = 'qfw-row__name';
			name.textContent = row.keyedName;
			const meta = document.createElement('div');
			meta.className = 'qfw-row__meta';
			meta.textContent = spec.fields
				.map((f) => row.fields[f.name])
				.filter((v) => v && normalizeTerm(v) !== normalizeTerm(row.keyedName))
				.join(' · ');
			text.append(name, meta);
			button.append(this.#buildIcon(spec.icon || DEFAULT_ICON), text);
			item.appendChild(button);
			return item;
		}

		#buildIcon(src) {
			// As stored ('../images/<name>.svg'): SvgManager recognises that form.
			if (customElements.get('aras-image')) {
				const image = document.createElement('aras-image');
				image.className = 'qfw-row__icon';
				image.setAttribute('aria-hidden', 'true');
				image.setAttribute('src', src);
				return image;
			}
			const image = document.createElement('img');
			image.className = 'qfw-row__icon';
			image.alt = '';
			try {
				image.src = new URL(src, aras.getMainWindow().location.href).href;
			} catch (ignored) {
				image.src = '';
			}
			return image;
		}

		#renderMessage(title, hint) {
			const message = document.createElement('div');
			message.className = 'qfw__message';
			const titleNode = document.createElement('div');
			titleNode.className = 'qfw__message-title';
			titleNode.textContent = title;
			message.appendChild(titleNode);
			if (hint) {
				const hintNode = document.createElement('div');
				hintNode.className = 'qfw__message-hint';
				hintNode.textContent = hint;
				message.appendChild(hintNode);
			}
			this.#root.insertBefore(message, this.#footer);
		}

		#removeMessage() {
			const existing = this.#root.querySelector('.qfw__message');
			if (existing) {
				existing.remove();
			}
		}

		// --------------------------------------------------------------- filter

		#renderFilterButton(count) {
			const button = this.#filterButton;
			if (!button) {
				return;
			}
			if (button.dataset.count !== String(count)) {
				button.dataset.count = String(count);
				button.innerHTML = FILTER_ICON;
				const badge = document.createElement('span');
				badge.textContent = String(count);
				button.appendChild(badge);
				button.title = `${LABELS.filterButton} (${count})`;
			}
			button.setAttribute('aria-expanded', this.#filter ? 'true' : 'false');
		}

		#openFilter() {
			// Re-read: the panel may have been built after the widget, or changed.
			this.#toc = readToc() || this.#toc;
			const toc = this.#tocList() || [];
			const draft = [];
			for (const t of this.#resolved()) {
				if (draft.some((d) => d.name === t.type)) {
					continue;
				}
				const entry = toc.find((e) => (t.id && e.id === t.id) || e.name === t.type);
				draft.push({
					id: entry ? entry.id : t.id,
					name: t.type,
					label: entry ? entry.label : (readMeta(t.type) || {}).label || t.type,
					fields: t.fields ? [...t.fields] : null
				});
			}
			// expanded: ItemTypes whose field list is open; open: TOC folders shown open.
			this.#filter = { draft, dirty: false, expanded: new Set(), open: new Set(), text: '' };
			this.#buildFilterPanel();
			this.#root.classList.add('qfw_filtering');
			this.#renderFilterButton(this.#getSpecs().length);
		}

		/** Applies the panel's choices (saving them if changed) and goes back to the results. */
		#closeFilter({ focus = false } = {}) {
			const filter = this.#filter;
			if (!filter) {
				return;
			}
			this.#filter = null;
			if (filter.dirty) {
				const text = serializeSelection(filter.draft);
				this.#saved = parseSavedSelection(text);
				writeStored(this.#storageKey(), text);
			}
			filter.panel.remove();
			this.#root.classList.remove('qfw_filtering');
			this.#specs = null;
			if (focus) {
				this.#input.focus();
			}
			this.#searchNow();
		}

		/** Forgets the user's choice: the widget's setting applies again. */
		#useDefaults() {
			writeStored(this.#storageKey(), null);
			this.#saved = null;
			if (this.#filter) {
				this.#filter.dirty = false;
			}
			this.#closeFilter({ focus: true });
		}

		#buildFilterPanel() {
			const filter = this.#filter;
			const panel = document.createElement('div');
			panel.className = 'qfw-filter';

			const head = document.createElement('div');
			head.className = 'qfw-filter__head';
			const search = document.createElement('input');
			search.type = 'search';
			search.className = 'qfw__input';
			search.placeholder = LABELS.filterSearch;
			search.setAttribute('aria-label', LABELS.filterSearch);
			search.autocomplete = 'off';
			search.spellcheck = false;
			search.addEventListener('input', () => {
				filter.text = search.value;
				this.#renderFilterBody();
			});
			head.appendChild(search);

			const body = document.createElement('div');
			body.className = 'qfw-filter__body';
			body.addEventListener('change', (event) => this.#onFilterChange(event.target));
			body.addEventListener('click', (event) => {
				const button = event.target.closest('[data-act="fields"], [data-act="folder"]');
				if (!button) {
					return;
				}
				const set = button.dataset.act === 'folder' ? filter.open : filter.expanded;
				const id = button.dataset.act === 'folder' ? button.dataset.folder : button.dataset.name;
				if (!set.delete(id)) {
					set.add(id);
				}
				this.#renderFilterBody();
			});

			const foot = document.createElement('div');
			foot.className = 'qfw-filter__foot';
			const note = document.createElement('div');
			note.className = 'qfw-filter__note';
			const defaults = document.createElement('button');
			defaults.type = 'button';
			defaults.className = 'qfw-filter__link';
			defaults.textContent = LABELS.useDefaults;
			defaults.addEventListener('click', () => this.#useDefaults());
			const done = document.createElement('button');
			done.type = 'button';
			done.className = 'qfw-filter__done';
			done.textContent = LABELS.done;
			done.addEventListener('click', () => this.#closeFilter({ focus: true }));
			foot.append(note, defaults, done);

			panel.addEventListener('keydown', (event) => {
				if (event.key !== 'Escape') {
					return;
				}
				event.preventDefault();
				if (event.target === search && search.value) {
					search.value = '';
					filter.text = '';
					this.#renderFilterBody();
				} else {
					this.#closeFilter({ focus: true });
				}
			});

			panel.append(head, body, foot);
			this.#root.insertBefore(panel, this.#list);
			Object.assign(filter, { panel, body, note });
			this.#renderFilterBody();
			search.focus();
		}

		#renderFilterBody() {
			const filter = this.#filter;
			if (!filter) {
				return;
			}
			const { body, draft } = filter;
			const active = document.activeElement;
			const focusKey = active && body.contains(active) ? active.dataset.key : null;
			const scroll = body.scrollTop;
			body.textContent = '';

			body.appendChild(this.#filterTitle(LABELS.selectedTitle(draft.length)));
			if (draft.length) {
				const list = document.createElement('ul');
				list.className = 'qfw-filter__list';
				draft.forEach((d) => list.appendChild(this.#buildSelectedRow(d)));
				body.appendChild(list);
			} else {
				body.appendChild(this.#filterEmpty(LABELS.selectedNone));
			}

			body.appendChild(this.#filterTitle(LABELS.allTitle));
			if (!this.#toc) {
				body.appendChild(this.#filterEmpty(LABELS.noToc));
			} else {
				// While filtering, every folder left is shown open.
				const searching = Boolean(normalizeTerm(filter.text));
				const tree = filterTree(this.#toc.tree, filter.text);
				if (tree.length) {
					body.appendChild(this.#buildTree(tree, 0, searching));
				} else {
					body.appendChild(this.#filterEmpty(LABELS.noMatch));
				}
			}

			filter.note.textContent = draft.length >= MAX_TYPES ? LABELS.atLimit : LABELS.note;
			body.scrollTop = scroll;
			if (focusKey) {
				const node = Array.from(body.querySelectorAll('[data-key]')).find(
					(n) => n.dataset.key === focusKey
				);
				if (node) {
					node.focus();
				}
			}
		}

		#filterTitle(text) {
			const title = document.createElement('div');
			title.className = 'qfw-filter__title';
			title.textContent = text;
			return title;
		}

		#filterEmpty(text) {
			const note = document.createElement('div');
			note.className = 'qfw-filter__empty';
			note.textContent = text;
			return note;
		}

		#checkbox({ act, name, field, key, checked, disabled }) {
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.dataset.act = act;
			box.dataset.name = name;
			if (field) {
				box.dataset.field = field;
			}
			box.dataset.key = key;
			box.checked = checked;
			box.disabled = disabled;
			return box;
		}

		/**
		 * One level of the navigation-panel tree: folders that open and close
		 * like the TOC's (all open while the filter text narrows the tree),
		 * each showing how many of its ItemTypes are searched, and ItemTypes
		 * with a checkbox. An ItemType listed in two folders shares one state.
		 */
		#buildTree(nodes, depth, searching) {
			const list = document.createElement('ul');
			list.className = 'qfw-filter__list';
			const selected = new Set(this.#filter.draft.map((d) => d.name));
			for (const node of nodes) {
				if (node.kind === 'type') {
					list.appendChild(this.#buildPickRow(node, depth));
					continue;
				}
				const open = searching || this.#filter.open.has(node.key);
				const count = new Set(typeNamesUnder(node).filter((name) => selected.has(name))).size;
				const item = document.createElement('li');
				item.className = 'qfw-folder';
				const head = document.createElement(searching ? 'div' : 'button');
				head.className = 'qfw-folder__head';
				head.style.paddingLeft = `${12 + depth * 16}px`;
				if (!searching) {
					head.type = 'button';
					head.dataset.act = 'folder';
					head.dataset.folder = node.key;
					head.dataset.key = 'folder:' + node.key;
					head.setAttribute('aria-expanded', open ? 'true' : 'false');
				}
				const chevron = document.createElement('span');
				chevron.className = 'qfw-folder__chevron' + (open ? ' qfw-folder__chevron_open' : '');
				chevron.setAttribute('aria-hidden', 'true');
				chevron.innerHTML = CHEVRON_ICON;
				const label = document.createElement('span');
				label.className = 'qfw-folder__label';
				label.textContent = node.label;
				head.append(chevron, label);
				if (count) {
					const badge = document.createElement('span');
					badge.className = 'qfw-folder__count';
					badge.textContent = String(count);
					badge.title = LABELS.folderCount(count);
					head.appendChild(badge);
				}
				item.appendChild(head);
				if (open) {
					item.appendChild(this.#buildTree(node.children, depth + 1, searching));
				}
				list.appendChild(item);
			}
			return list;
		}

		#buildPickRow(t, depth = 0) {
			const checked = this.#filter.draft.some((d) => d.name === t.name);
			const disabled = !checked && this.#filter.draft.length >= MAX_TYPES;
			const item = document.createElement('li');
			item.className = 'qfw-pick';
			// Under its folder's label: the checkbox lines up with the folder text.
			item.style.paddingLeft = `${12 + depth * 16 + (depth ? 4 : 0)}px`;
			const row = document.createElement('div');
			row.className = 'qfw-pick__row';
			const label = document.createElement('label');
			label.className = 'qfw-pick__label' + (disabled ? ' qfw-pick__label_disabled' : '');
			label.title = disabled ? LABELS.atLimit : `${t.label} (${t.name})`;
			const text = document.createElement('span');
			text.textContent = t.label;
			label.append(
				this.#checkbox({ act: 'type', name: t.name, key: 'all:' + t.key, checked, disabled }),
				text
			);
			row.appendChild(label);
			item.appendChild(row);
			return item;
		}

		/** A searched ItemType: its checkbox, and the dropdown of fields. */
		#buildSelectedRow(d) {
			const meta = readMeta(d.name);
			const spec = buildSpec(d.name, d.fields, meta);
			const options = fieldOptions(meta);
			const chosen = spec.error ? [] : spec.fields.map((f) => f.name);
			const labelOf = (name) => (options.find((o) => o.name === name) || { label: name }).label;
			const expanded = this.#filter.expanded.has(d.name);

			const item = document.createElement('li');
			item.className = 'qfw-pick';
			const row = document.createElement('div');
			row.className = 'qfw-pick__row';
			const label = document.createElement('label');
			label.className = 'qfw-pick__label';
			label.title = `${d.label} (${d.name})`;
			const text = document.createElement('span');
			text.textContent = d.label;
			label.append(
				this.#checkbox({ act: 'type', name: d.name, key: 'sel:' + d.name, checked: true, disabled: false }),
				text
			);

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'qfw-pick__fields';
			button.dataset.act = 'fields';
			button.dataset.name = d.name;
			button.dataset.key = 'fields:' + d.name;
			button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
			const summary = chosen.length ? chosen.map(labelOf).join(', ') : LABELS.fieldsUnavailable;
			button.title = `${LABELS.fields}: ${summary}`;
			const summaryNode = document.createElement('span');
			summaryNode.textContent = summary;
			const caret = document.createElement('span');
			caret.setAttribute('aria-hidden', 'true');
			caret.textContent = expanded ? '▴' : '▾';
			button.append(summaryNode, caret);
			row.append(label, button);
			item.appendChild(row);

			if (expanded) {
				const list = document.createElement('ul');
				list.className = 'qfw-fields';
				if (!options.length) {
					list.appendChild(this.#filterEmpty(LABELS.fieldsUnavailable));
				}
				let dividerShown = false;
				for (const option of options) {
					if (option.hidden && !dividerShown) {
						dividerShown = true;
						const divider = document.createElement('li');
						divider.className = 'qfw-fields__divider';
						divider.textContent = LABELS.fieldsHidden;
						list.appendChild(divider);
					}
					const checked = chosen.includes(option.name);
					const last = checked && chosen.length === 1;
					const entry = document.createElement('li');
					const fieldLabel = document.createElement('label');
					fieldLabel.className = 'qfw-fields__label';
					fieldLabel.title = last ? LABELS.lastField : option.name;
					const fieldText = document.createElement('span');
					fieldText.textContent = option.label;
					fieldLabel.append(
						this.#checkbox({
							act: 'field',
							name: d.name,
							field: option.name,
							key: `field:${d.name}:${option.name}`,
							checked,
							disabled: last
						}),
						fieldText
					);
					entry.appendChild(fieldLabel);
					list.appendChild(entry);
				}
				item.appendChild(list);
			}
			return item;
		}

		#onFilterChange(input) {
			const filter = this.#filter;
			if (!filter || !input || !input.dataset) {
				return;
			}
			const name = input.dataset.name;
			if (input.dataset.act === 'type') {
				const index = filter.draft.findIndex((d) => d.name === name);
				if (input.checked && index < 0 && filter.draft.length < MAX_TYPES) {
					const entry = (this.#tocList() || []).find((t) => t.name === name);
					filter.draft.push({ id: entry ? entry.id : '', name, label: entry ? entry.label : name, fields: null });
				} else if (!input.checked && index >= 0) {
					filter.draft.splice(index, 1);
					filter.expanded.delete(name);
				}
				filter.dirty = true;
			} else if (input.dataset.act === 'field') {
				const d = filter.draft.find((x) => x.name === name);
				if (!d) {
					return;
				}
				const meta = readMeta(name);
				const spec = buildSpec(name, d.fields, meta);
				const chosen = new Set(spec.error ? defaultFields(meta) : spec.fields.map((f) => f.name));
				if (input.checked) {
					chosen.add(input.dataset.field);
				} else if (chosen.size > 1) {
					chosen.delete(input.dataset.field);
				}
				d.fields = fieldOptions(meta)
					.map((o) => o.name)
					.filter((n) => chosen.has(n));
				filter.dirty = true;
			}
			this.#renderFilterBody();
		}

		// ------------------------------------------------------------- keyboard

		#onKeyDown(event) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (!this.#flat.length) {
					return;
				}
				const index = this.#flat.findIndex((r) => r.id === this.#activeId);
				const step = event.key === 'ArrowDown' ? 1 : -1;
				const next = index < 0 ? (step > 0 ? 0 : this.#flat.length - 1) : (index + step + this.#flat.length) % this.#flat.length;
				this.#activeId = this.#flat[next].id;
				this.#highlightActive();
			} else if (event.key === 'Enter') {
				event.preventDefault();
				if (this.#timer) {
					// Typed and pressed Enter before the debounce ran: search first.
					this.#searchNow();
					return;
				}
				const row = this.#flat.find((r) => r.id === this.#activeId) || this.#flat[0];
				if (row) {
					this.#open(row.type, row.id);
				}
			} else if (event.key === 'Escape') {
				this.#input.value = '';
				this.#searchNow();
			}
		}

		#highlightActive() {
			for (const node of this.#list.querySelectorAll('.qfw-row')) {
				const active = node.dataset.id === this.#activeId;
				node.classList.toggle('qfw-row_active', active);
				if (active) {
					node.scrollIntoView({ block: 'nearest' });
				}
			}
		}

		/**
		 * Results are the current generation (is_current = 1), so the id opens
		 * the latest version directly. uiShowItem re-fetches the item and runs
		 * the ItemType's OnShowItem.
		 */
		#open(type, id) {
			if (type && id) {
				aras.uiShowItem(type, id);
			}
		}
	};
}
