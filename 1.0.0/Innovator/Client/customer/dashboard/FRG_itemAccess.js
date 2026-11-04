/**
 * Which listed items the user can still read, for the Favorites and Recently
 * Viewed widgets.
 *
 * Both widgets list items from data saved earlier: a favorite, or an entry in
 * the recents list. Neither is re-checked when access changes, so an item hidden
 * since then (a Mandatory Access Control policy, a permission change, a
 * deletion) would still be listed, with its name. The widgets show only what
 * this module confirms the server still returns to the user.
 *
 * One query per ItemType, select="id,config_id", matching each entry by:
 *   - config_id + is_current='1' when the entry knows its configId: the latest
 *     generation, which is what the widgets open. Non-versionable items are
 *     their own config and always current, so the same clause fits them;
 *   - id otherwise (a recents entry whose configId is not resolved yet).
 * The server applies every access rule to that query, so an item missing from
 * the answer is not readable. A query that matches nothing comes back as SOAP
 * fault 0 ("No items of type X found"): all of those entries are unreadable.
 * Any other failure (network, another fault) leaves the entries shown, with a
 * console warning: the widget then lists what it listed before, and opening a
 * hidden item still ends in the server's "access restricted" alert.
 *
 * Results are cached for the session on the main window, so every dashboard
 * shares them, as plain data only: promises and callbacks stay in the window
 * that made them, which may be a tab that closes. Requests in flight are
 * shared within one window.
 */

const ID_PATTERN = /^[0-9A-F]{32}$/i;
const CHUNK = 100;
/** How old a cached answer may be before a render asks again. */
export const DEFAULT_MAX_AGE_MS = 60000;
const NO_ITEMS_FAULT = '0';

const xmlAttr = (value) =>
	String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const inList = (ids) => ids.map((id) => `'${id}'`).join(',');

/**
 * The entry fields this module reads: { type, id, configId }. configId may be
 * null; a favorite passes its stored id as both (it is the config_id).
 */
export const accessKey = (ref) =>
	ref.type + '|' + (ref.configId ? 'c:' + ref.configId : 'i:' + ref.id);

const sharedCache = () => {
	const mainWindow = aras.getMainWindow();
	return (mainWindow.customerItemAccess ??= new mainWindow.Map());
};

// accessKey -> Promise, for this window only.
const inflight = new Map();

/**
 * What is known now, without a request: `known` maps accessKey -> true/false
 * for every entry checked before (however long ago), and `stale` lists the
 * entries never checked, or last checked before `notBefore` (a time in ms) or
 * more than DEFAULT_MAX_AGE_MS ago. A widget passes the time it was loaded or
 * refreshed, so those always ask the server once.
 */
export const peekReadable = (refs, notBefore = 0) => {
	const cache = sharedCache();
	const limit = Math.max(notBefore, Date.now() - DEFAULT_MAX_AGE_MS);
	const known = new Map();
	const stale = [];
	for (const ref of refs) {
		const key = accessKey(ref);
		const hit = cache.get(key);
		if (hit) {
			known.set(key, hit.readable);
		}
		if (!hit || hit.at < limit) {
			stale.push(ref);
		}
	}
	return { known, stale };
};

/**
 * The entries known to be readable, in their order, for a widget's render.
 * Entries with no answer yet are left out, never shown first and removed
 * later: that would show the very names this module hides. Stale ones are
 * handed to onStale, to check and render again.
 */
export const readableEntries = (entries, toRef, notBefore, onStale) => {
	const refs = entries.map(toRef);
	const { known, stale } = peekReadable(refs, notBefore);
	if (stale.length) {
		onStale(stale);
	}
	return entries.filter((entry, index) => known.get(accessKey(refs[index])) === true);
};

/** Returns the set of item ids and config ids the server returned. */
const queryType = async (type, configIds, ids) => {
	const clauses = [];
	if (configIds.length) {
		clauses.push(
			`<and><config_id condition="in">${inList(configIds)}</config_id><is_current>1</is_current></and>`
		);
	}
	if (ids.length) {
		clauses.push(`<id condition="in">${inList(ids)}</id>`);
	}
	const where = clauses.length > 1 ? `<or>${clauses.join('')}</or>` : clauses[0];
	const body = `<Item type="${xmlAttr(type)}" action="get" select="id,config_id">${where}</Item>`;
	const found = new Set();
	let result;
	try {
		result = await ArasModules.soap(body, {
			method: 'ApplyItem',
			async: true,
			headers: aras.getHttpHeadersForSoapMessage('ApplyItem'),
			url: aras.getServerURL()
		});
	} catch (error) {
		if (faultCode(error) === NO_ITEMS_FAULT) {
			return found;
		}
		throw error;
	}
	for (const item of Array.from(result.getElementsByTagName('Item'))) {
		const configNode = item.getElementsByTagName('config_id')[0];
		found.add('i:' + item.getAttribute('id'));
		if (configNode && configNode.textContent) {
			found.add('c:' + configNode.textContent.trim());
		}
	}
	return found;
};

/** faultcode of a rejected ArasModules.soap call, or null if it was not a SOAP fault. */
const faultCode = (error) => {
	if (typeof XMLHttpRequest === 'undefined' || !(error instanceof XMLHttpRequest)) {
		return null;
	}
	try {
		const doc =
			error.responseXML ||
			new DOMParser().parseFromString(error.responseText || '', 'text/xml');
		const node = doc && doc.getElementsByTagName('faultcode')[0];
		return node ? node.textContent.trim() : null;
	} catch (ignored) {
		return null;
	}
};

/** Checks one ItemType's entries and stores the answers. */
const checkType = async (type, refs) => {
	const cache = sharedCache();
	const configIds = [];
	const ids = [];
	for (const ref of refs) {
		if (ref.configId && ID_PATTERN.test(ref.configId)) {
			configIds.push(ref.configId);
		} else if (ID_PATTERN.test(ref.id)) {
			ids.push(ref.id);
		}
	}
	const found = new Set();
	try {
		for (let i = 0; i < Math.max(configIds.length, ids.length); i += CHUNK) {
			(
				await queryType(type, configIds.slice(i, i + CHUNK), ids.slice(i, i + CHUNK))
			).forEach((key) => found.add(key));
		}
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn('[FRG widgets] could not check access to ' + type + ' items; showing them', error);
		const at = Date.now();
		refs.forEach((ref) => cache.set(accessKey(ref), { readable: true, at }));
		return;
	}
	const at = Date.now();
	for (const ref of refs) {
		const key = accessKey(ref);
		const readable = key.slice(key.indexOf('|') + 1);
		cache.set(key, { readable: found.has(readable), at });
	}
};

/**
 * Asks the server about the given entries (one query per ItemType, in
 * parallel) and resolves once the cache holds an answer for each. An entry
 * already being checked in this window waits for that request instead.
 */
export const checkReadable = async (refs) => {
	const waits = [];
	const byType = new Map();
	for (const ref of refs) {
		if (!ref || !ref.type || !(ref.id || ref.configId)) {
			continue;
		}
		const key = accessKey(ref);
		if (inflight.has(key)) {
			waits.push(inflight.get(key));
			continue;
		}
		if (!byType.has(ref.type)) {
			byType.set(ref.type, new Map());
		}
		byType.get(ref.type).set(key, ref);
	}
	for (const [type, map] of byType) {
		const done = checkType(type, [...map.values()]).finally(() =>
			map.forEach((ref, key) => inflight.delete(key))
		);
		map.forEach((ref, key) => inflight.set(key, done));
		waits.push(done);
	}
	await Promise.all(waits);
};
