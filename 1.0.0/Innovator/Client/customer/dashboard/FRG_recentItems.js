/**
 * Shared "recently viewed items" service.
 *
 * One instance per session, kept on the main window (mainWindow.customerRecentItems).
 * Every window that imports this module resolves to the object created by the first
 * caller, so there is exactly one debounce timer and one load per session.
 *
 * Three layers:
 *
 *   1. Capture   - watches the main window's tab list in the client store and
 *                  records each item tab as it opens (see installTabCapture).
 *   2. Session   - the list lives in the shared client store under the layout key
 *                  'customer.recentlyViewed'. Any window can read it, and
 *                  store.subscribe fires in every window when it changes.
 *   3. Persist   - mirrored as JSON into a property on the user's
 *                  Core_GlobalLayout preference. The client already saves changed
 *                  preferences on logout, so this only adds a debounced save plus
 *                  one when the page is hidden.
 *
 * WHY Core_GlobalLayout AND NOT A DEDICATED PREFERENCE ITEMTYPE
 * The client loads this preference at login, so reading it costs no server call;
 * the row always exists, so there is no first-write race between sessions; and it
 * is saved with a merge. In exchange the payload travels with every login, which
 * is why CAP is deliberately modest.
 *
 * NOTE ON READING BACK: consumers must use subscribe(), not mapStateToProps. A
 * layout's mapStateToProps is not re-run for the very update that changes this
 * list, so a mapStateToProps consumer would show stale data until some unrelated
 * update arrived.
 *
 * VERSIONABLE ITEMS
 * Each generation of a versionable item has its own id, so an item opened, then
 * versioned and opened again would be listed once per generation. Entries carry
 * the item's configId (shared by every generation, see FRG_itemVersions.js) and
 * the list keeps one entry per configId: the newest open. Entries saved before
 * configId existed are resolved once per session, with one query per ItemType.
 * The widget opens the latest generation whichever one an entry points at.
 */

import { isVersionable, knownConfigId, versionKey } from './FRG_itemVersions.js';

const STORE_KEY = 'customer.recentlyViewed';
const PREF_TYPE = 'Core_GlobalLayout';

/**
 * cust_ rather than core_ on purpose: this is a customer property on a core
 * ItemType, and the prefix keeps it clear of anything a future Aras upgrade adds.
 */
const PREF_PROP = 'cust_recent_items';

/**
 * Hard cap on what is kept and persisted. Kept modest because this payload is part
 * of the login bootstrap for every user, whether or not they use the widget:
 * 25 entries is roughly 4KB of JSON, and the widget shows 15 by default.
 */
const CAP = 25;
const FLUSH_DELAY_MS = 10000;
const DEFAULT_ICON = '../images/DefaultItemType.svg';

/**
 * ItemType *names*, not labels. The Dashboard ItemType is named `cui_Dashboard` and
 * only its label reads "Dashboard" - excluding the label silently matches nothing.
 * It is excluded because the widget lives on a dashboard: without this, opening one
 * would always put the dashboard itself at the top of its own list.
 */
const EXCLUDED_TYPES = new Set(['cui_Dashboard', 'Preference']);

/**
 * The main window layout's state is found STRUCTURALLY, by looking for the slice
 * that owns `splitScreen.tabs`, never by its store key: the key is generated at
 * runtime and is not predictable.
 */
const hasTabState = (slice) =>
	Boolean(slice && slice.splitScreen && slice.splitScreen.tabs);

/** Frozen so the identity check in subscribers is stable while the list is empty. */
const EMPTY = Object.freeze([]);

const isValidEntry = (entry) =>
	Boolean(entry && typeof entry === 'object' && entry.id && entry.type);

/** Keeps the first (newest) entry of each item, across its generations. */
const dedupe = (items) => {
	const seen = new Set();
	return items.filter((entry) => {
		const key = versionKey(entry);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
};

const ID_PATTERN = /^[0-9A-F]{32}$/i;
const xmlAttr = (value) =>
	String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const create = (mainWindow) => {
	// Deliberately shadows the ambient `aras`. This singleton outlives whichever
	// window happened to create it — if a dashboard in a tab constructs it first,
	// closing over that tab's Aras instance would leave a dead reference behind the
	// moment the tab closes. The main window's instance lives as long as the session.
	const aras = mainWindow.aras || window.aras;

	const store = mainWindow.store;
	let loaded = false;
	let flushTimer = null;
	// Flipped off permanently if the preference row cannot be reached, so a
	// misconfigured instance cannot produce repeated failures.
	let persistable = true;

	const read = () => {
		const slice = store.getState().layout[STORE_KEY];
		return slice && Array.isArray(slice.items) ? slice.items : EMPTY;
	};

	const write = (items) =>
		store.boundActionCreators.updateLayoutData(STORE_KEY, { items });

	/**
	 * Synchronous and free: Core_GlobalLayout is already loaded at login.
	 *
	 * Entries are stored complete - including typeLabel and icon - rather than
	 * re-resolved from metadata on load. Looking up an ItemType that has since been
	 * deleted or made invisible would show the user an error dialog.
	 */
	const load = () => {
		if (loaded) {
			return;
		}
		loaded = true;

		try {
			const preferenceNode = aras.getPreferenceItem(PREF_TYPE, null);
			if (!preferenceNode) {
				persistable = false;
				console.warn(
					'[RecentItems] ' +
						PREF_TYPE +
						' is unavailable; the list will not persist between sessions.'
				);
				return;
			}

			const propertyNode = preferenceNode.selectSingleNode(PREF_PROP);
			if (!propertyNode) {
				// Either nothing has been stored yet, or the property is missing from
				// the bootstrap payload. Worth naming, because the second case looks
				// identical to the first and silently loses every session.
				console.info(
					'[RecentItems] no stored list on ' +
						PREF_TYPE +
						'. If this persists after a flush, check that the property ' +
						PREF_PROP +
						' exists and is not excluded by a select list in the ' +
						'CoreGlobalLayoutPreference bootstrap method.'
				);
				return;
			}

			const raw = propertyNode.text || '';
			const parsed = raw ? JSON.parse(raw) : [];
			// Anything captured before load ran outranks the persisted copy.
			if (Array.isArray(parsed) && read().length === 0) {
				write(dedupe(parsed.filter(isValidEntry)).slice(0, CAP));
			}
		} catch (ex) {
			console.warn('[RecentItems] could not read stored list', ex);
		}
		// Off the load path: load() is synchronous and runs during a widget's init.
		setTimeout(backfillConfigIds, 0);
	};

	/** config_id of each id, for one versionable ItemType: one async query. */
	const fetchConfigIds = async (type, ids) => {
		const found = new Map();
		const valid = ids.filter((id) => ID_PATTERN.test(id));
		if (!valid.length || !mainWindow.ArasModules) {
			return found;
		}
		const body =
			`<Item type="${xmlAttr(type)}" action="get" select="config_id" idlist="${valid.join(',')}"/>`;
		// Rejects with a SOAP fault when none of the ids can be read (deleted, no
		// access); the caller keeps those entries as they are.
		const result = await mainWindow.ArasModules.soap(body, {
			method: 'ApplyItem',
			async: true,
			headers: aras.getHttpHeadersForSoapMessage('ApplyItem'),
			url: aras.getServerURL()
		});
		for (const item of Array.from(result.getElementsByTagName('Item'))) {
			const id = item.getAttribute('id');
			const configNode = item.getElementsByTagName('config_id')[0];
			const configId = configNode && configNode.textContent.trim();
			if (id && configId) {
				found.set(id, configId);
			}
		}
		return found;
	};

	/**
	 * Gives entries without a configId (saved before it existed, or captured
	 * before the item reached the items cache) their configId, then drops the
	 * older generations' duplicates. Each id is queried at most once per
	 * session; one that cannot be resolved stays as it is.
	 */
	const attempted = new Set();
	let backfillRunning = false;
	const backfillConfigIds = async () => {
		if (backfillRunning) {
			return;
		}
		backfillRunning = true;
		try {
			await resolveMissingConfigIds();
		} finally {
			backfillRunning = false;
		}
		// An entry pushed while this ran.
		if (read().some((entry) => !entry.configId && !attempted.has(entry.id))) {
			setTimeout(backfillConfigIds, 0);
		}
	};
	const resolveMissingConfigIds = async () => {
		const resolved = new Map();
		const pending = new Map();
		for (const entry of read()) {
			if (entry.configId || attempted.has(entry.id)) {
				continue;
			}
			attempted.add(entry.id);
			const known = knownConfigId(entry.type, entry.id, null, aras);
			if (known) {
				resolved.set(entry.id, known);
			} else if (isVersionable(entry.type, aras)) {
				if (!pending.has(entry.type)) {
					pending.set(entry.type, []);
				}
				pending.get(entry.type).push(entry.id);
			}
		}
		for (const [type, ids] of pending) {
			try {
				(await fetchConfigIds(type, ids)).forEach((configId, id) =>
					resolved.set(id, configId)
				);
			} catch (ex) {
				console.info('[RecentItems] could not resolve versions for ' + type, ex);
			}
		}
		if (!resolved.size) {
			return;
		}
		// Applied to the list as it is now: items may have been opened meanwhile.
		const current = read();
		const next = dedupe(
			current.map((entry) =>
				!entry.configId && resolved.has(entry.id)
					? { ...entry, configId: resolved.get(entry.id) }
					: entry
			)
		);
		write(next);
		scheduleFlush();
	};

	const flush = () => {
		clearTimeout(flushTimer);
		flushTimer = null;
		if (!persistable) {
			return;
		}

		try {
			// Updates the cached preference; savePreferenceItems writes it back.
			aras.setPreferenceItemProperties(PREF_TYPE, null, {
				[PREF_PROP]: JSON.stringify(read())
			});
			aras.savePreferenceItems();
		} catch (ex) {
			console.warn('[RecentItems] flush failed', ex);
		}
	};

	const scheduleFlush = () => {
		clearTimeout(flushTimer);
		flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
	};

	// Saved on visibilitychange rather than pagehide: a request started during
	// pagehide may not complete. Logout is already covered by the client.
	mainWindow.document.addEventListener('visibilitychange', () => {
		if (mainWindow.document.visibilityState === 'hidden' && flushTimer) {
			flush();
		}
	});

	const push = (entry) => {
		if (!entry || !entry.id || !entry.type || EXCLUDED_TYPES.has(entry.type)) {
			return;
		}
		load();
		// One entry per item: an earlier open of any generation is replaced.
		const key = versionKey(entry);
		write(
			[entry, ...read().filter((i) => i.id !== entry.id && versionKey(i) !== key)].slice(
				0,
				CAP
			)
		);
		scheduleFlush();
		if (!entry.configId) {
			setTimeout(backfillConfigIds, 0);
		}
	};

	const findMainWindowTabs = () => {
		const { layout } = store.getState();
		for (const key of Object.keys(layout)) {
			if (hasTabState(layout[key])) {
				return layout[key].splitScreen.tabs;
			}
		}
		return null;
	};

	/**
	 * The capture path.
	 *
	 * Each open item tab carries { itemId, itemTypeId, image, label } in the main
	 * window layout's splitScreen.tabs - the keyed name and the ItemType icon, which
	 * is exactly what an entry needs. So the store already lists every open item;
	 * this just watches for new ones, without editing any item view page.
	 */
	const installTabCapture = () => {
		// tab id -> the item id recorded for it. A tab whose item changes (a new
		// generation shown in place) is recorded again.
		const recorded = new Map();
		let prevLayout = null;

		const scan = () => {
			// This runs on every store update, most of which do not touch layout.
			// The layout object is replaced whenever it changes, so a reference
			// compare skips the walk entirely.
			const { layout } = store.getState();
			if (layout === prevLayout) {
				return;
			}
			prevLayout = layout;

			const tabs = findMainWindowTabs();
			if (!tabs) {
				return;
			}

			for (const [tabId, tab] of Object.entries(tabs)) {
				// Item tabs are the only ones carrying both; search, form and page
				// tabs are skipped. A new tab is also seen once before these fields
				// are filled in, hence the guard rather than a blanket recorded.add().
				if (!tab || !tab.itemId || !tab.itemTypeId || recorded.get(tabId) === tab.itemId) {
					continue;
				}
				recorded.set(tabId, tab.itemId);
				recordTab(tab);
			}

			// Forget closed tabs so reopening the same item records it again.
			for (const tabId of [...recorded.keys()]) {
				if (!(tabId in tabs)) {
					recorded.delete(tabId);
				}
			}
		};

		scan();
		return store.subscribe(scan);
	};

	const recordTab = (tab) => {
		const type = aras.getItemTypeName(tab.itemTypeId);
		if (!type) {
			return;
		}

		const itemTypeNode = aras.getItemTypeNodeForClient(type);
		push({
			id: tab.itemId,
			// From the items cache, where the opened item already is; if it is not
			// there yet, backfillConfigIds resolves it right after the push.
			configId: knownConfigId(type, tab.itemId, null, aras),
			type,
			typeLabel:
				(itemTypeNode && aras.getItemProperty(itemTypeNode, 'label')) || type,
			keyedName: tab.label || tab.itemId,
			icon: tab.image || DEFAULT_ICON,
			ts: Date.now()
		});
	};

	installTabCapture();

	return {
		read,
		subscribe: store.subscribe,

		/** Promise-shaped for callers; the underlying read is synchronous. */
		ensureLoaded() {
			load();
			return Promise.resolve();
		},

		/**
		 * Secondary capture path, for opens the tab watcher cannot see — chiefly
		 * tear-off windows, which never reach splitScreen.tabs because
		 * setTitleTabWithFrame returns early when there is no frameElement.
		 *
		 * Call from a client Method (OnShowItemDefault) rather than a static file:
		 * anything in the item view chain is behind the service worker precache.
		 * Safe to run alongside the tab watcher — push() dedupes by id.
		 *
		 * @param itemNd        - the item XML node
		 * @param itemTypeName  - the ItemType name
		 */
		record(itemNd, itemTypeName) {
			if (!itemNd || !itemTypeName) {
				return;
			}

			const id = itemNd.getAttribute('id');
			// An item being created, not viewed.
			if (!id || aras.isTempID(id)) {
				return;
			}

			const itemTypeNode = aras.getItemTypeNodeForClient(itemTypeName);
			push({
				id,
				configId: knownConfigId(itemTypeName, id, itemNd, aras),
				type: itemTypeName,
				typeLabel:
					(itemTypeNode && aras.getItemProperty(itemTypeNode, 'label')) ||
					itemTypeName,
				keyedName: aras.getItemProperty(itemNd, 'keyed_name') || id,
				icon:
					(itemTypeNode && aras.getItemProperty(itemTypeNode, 'open_icon')) ||
					DEFAULT_ICON,
				ts: Date.now()
			});
		},

		/**
		 * Drops one entry, by item id. Every window's widgets repaint through
		 * subscribe(), and the change is saved with the usual debounced flush.
		 * An item still open in a tab is not re-added: the tab watcher has
		 * already recorded that tab, so only reopening the item brings it back.
		 */
		remove(id) {
			if (!id) {
				return;
			}
			load();
			const items = read();
			const next = items.filter((entry) => entry.id !== id);
			if (next.length === items.length) {
				return;
			}
			write(next);
			scheduleFlush();
		},

		clear() {
			write(EMPTY);
			flush();
		},

		flushNow: flush
	};
};

export const getRecentItems = () => {
	const mainWindow = aras.getMainWindow();
	return (mainWindow.customerRecentItems ??= create(mainWindow));
};

export default getRecentItems;
