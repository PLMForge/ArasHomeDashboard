/**
 * "RecentlyViewed" - custom Dashboard Widget layout.
 *
 * Lists the items the user has opened, newest first and kept between sessions,
 * with a dropdown that filters by ItemType.
 * Updates live: opening an item in any tab repaints this widget with no server call.
 *
 * WHY NOT THE STANDARD Grid WIDGET
 * The Grid widget queries the server when its own settings change. It does not
 * react to the client store, so it would need a manual refresh to show an item
 * opened seconds ago.
 *
 * WHY store.subscribe AND NOT mapStateToProps
 * mapStateToProps is not re-run for the very update that changes the recents
 * list, so the widget would stay stale. Subscribing directly avoids that. The
 * widget's OWN state (the filter) does go through setState/updateLayout, and
 * is saved to localStorage per user and per widget so it survives a reload.
 *
 * The WidgetLayout base class and the recentItems service are passed IN rather than
 * imported: the dashboard editor must see the very same class it already holds,
 * and a separate import could load a second copy of it (see
 * FRG_registerWidgets.js).
 *
 * Registered by FRG_registerWidgets.js:
 *   addWidgetLayout({ RecentlyViewed: createRecentlyViewedLayout(WidgetLayout, recentItems) });
 *
 * Right-clicking a row offers Hide from Recently Viewed, which drops the
 * entry from the shared list (see FRG_widgetContextMenu.js). The item itself
 * is untouched and comes back the next time it is opened. The label says
 * 'Hide' on purpose: 'Remove' or 'Delete' next to an item reads as an action
 * on the item.
 *
 * Only items the user can still read are listed: an entry the user has lost
 * access to since (a Mandatory Access Control policy, a permission change, a
 * deletion) is hidden, not dropped from the list, and comes back if access
 * does (FRG_itemAccess.js). Each load and Refresh asks the server again.
 */

import { attachContextMenu, reportActionError } from './FRG_widgetContextMenu.js';
import { openLatestItem } from './FRG_itemVersions.js';
import { checkReadable, readableEntries } from './FRG_itemAccess.js';
import { allowFormControls } from './FRG_widgetInput.js';

const STYLE_ELEMENT_ID = 'recently-viewed-widget-style';
const DEFAULT_MAX_ITEMS = 15;
const ALL_TYPES_KEY = '__all';

// English only. To translate, replace these with aras.getResource('', '<key>')
// lookups.
const LABELS = {
	empty: 'Nothing viewed yet',
	emptyHint: 'Items you open will be listed here.',
	emptyFiltered: 'No recent items of this type',
	emptyFilteredHint: 'Choose a different type from the filter.',
	allTypes: 'All types',
	filterTitle: 'Filter by ItemType',
	typeLabel: 'Type',
	openHint: (name) => 'Open ' + name,
	remove: 'Hide from Recently Viewed',
	justNow: 'just now'
};

/**
 * Self-contained: the dashboard page has no list styles to reuse. Sizes and
 * colours are chosen to sit next to the standard widgets without looking foreign:
 * row hover uses the grid's hover colour, and text uses the widget-title colour.
 *
 * Colours: every value is a var(--token, light literal) expression using the
 * client's own colour tokens, so a theme that redefines those tokens restyles
 * the widget along with the rest of the client. Keep the light fallbacks: this
 * page does not define the tokens itself.
 */
const STYLES = `
.rvw {
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	font: 400 1rem/1.4 Roboto, 'Noto Sans JP', Arial, sans-serif;
	color: var(--gray900, #4f4f4f);
}
.rvw__toolbar {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--gray400, #dfdfdf);
}
.rvw__toolbar-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .04em;
	opacity: .7;
}
.rvw__filter-caret {
	font-size: 10px;
	line-height: 1;
	opacity: .65;
}
.rvw__filter-fallback {
	font: inherit;
	padding: 2px 4px;
	border: 1px solid var(--gray500, #cfcfcf);
	border-radius: 4px;
	background: var(--white, #ffffff);
	color: inherit;
	max-width: 60%;
}
/*
 * Empty and error states: every path that shows a message empties the list
 * first. The empty list steps aside and the message takes its space, centred
 * both ways below the toolbar. (Appended after a flex: 1 list, the message
 * would otherwise sit at the very bottom of the widget.)
 */
.rvw__list:empty {
	display: none;
}
.rvw__list {
	flex: 1 1 auto;
	overflow: auto;
	padding: 4px 0;
	margin: 0;
	list-style: none;
}
.rvw-row {
	display: block;
}
.rvw-row__button {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 12px;
	background: transparent;
	border: 0;
	border-left: 3px solid transparent;
	text-align: left;
	cursor: pointer;
	font: inherit;
	color: inherit;
}
.rvw-row__button:hover {
	background-color: var(--gray300, #ebebeb);
}
.rvw-row__button:focus {
	outline: 0;
}
.rvw-row__button:focus-visible {
	border-left-color: var(--focus, #0f66cb);
	background-color: var(--gray300, #ebebeb);
}
.rvw-row__icon {
	height: 1.833rem;
	width: 1.833rem;
	flex-shrink: 0;
	display: block;
}
img.rvw-row__icon {
	object-fit: contain;
}
.rvw-row__text {
	min-width: 0;
	flex: 1 1 auto;
}
.rvw-row__name {
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.rvw-row__meta {
	font-size: 11px;
	opacity: .7;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.rvw__message {
	flex: 1 1 auto;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	padding: 16px 12px;
	font-size: 12px;
	line-height: 1.4;
	text-align: center;
}
.rvw__message-title {
	font-size: 13px;
	font-weight: 500;
}
.rvw__message-hint {
	padding-top: 4px;
	opacity: .75;
}
.rvw_state-loading {
	opacity: .5;
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

/** Coarse on purpose: the list is ordered, so this is a hint, not a clock. */
const formatAge = (timestamp) => {
	const elapsed = Date.now() - (timestamp || 0);
	if (!Number.isFinite(elapsed) || elapsed < 60000) {
		return LABELS.justNow;
	}
	const minutes = Math.floor(elapsed / 60000);
	if (minutes < 60) {
		return minutes + 'm ago';
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours + 'h ago';
	}
	return Math.floor(hours / 24) + 'd ago';
};

/** Distinct ItemTypes present in the list, for the filter dropdown. */
const buildTypeOptions = (items) => {
	const seen = new Map();
	items.forEach((item) => {
		if (!seen.has(item.type)) {
			seen.set(item.type, item.typeLabel || item.type);
		}
	});
	return [...seen.entries()]
		.map(([type, label]) => ({ type, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
};

const optionsSignature = (options) => options.map((option) => option.type).join('|');

const accessRef = (item) => ({ type: item.type, id: item.id, configId: item.configId || null });

// ---------------------------------------------------------- saved filter
// The Type filter is kept in localStorage, per user and per widget, so it
// survives a browser reload. The widget part of the key is the Dashboard
// Widget relationship id, which the editor puts on the widget wrapper as
// data-id; the layout's own id is regenerated on every load and is useless
// here. The database name keeps instances on one host apart, since they share
// one localStorage, including a database cloned from another with the same
// widget ids. Without a wrapper or a user the filter simply is not saved.
const FILTER_STORAGE_PREFIX = 'FRG.RecentlyViewed.filterType';

const filterStorageKey = (dom) => {
	const wrapper = dom && dom.closest ? dom.closest('aras-dashboard-widget') : null;
	const widgetId = wrapper ? wrapper.dataset.id : '';
	if (!widgetId || typeof aras === 'undefined') {
		return null;
	}
	const database = aras.getDatabase ? aras.getDatabase() : '';
	const userId = aras.getUserID ? aras.getUserID() : '';
	return userId ? `${FILTER_STORAGE_PREFIX}.${database}.${userId}.${widgetId}` : null;
};

// localStorage can throw (storage disabled, quota); a lost preference is fine.
const readSavedFilter = (key) => {
	try {
		return (key && localStorage.getItem(key)) || null;
	} catch (error) {
		return null;
	}
};

const writeSavedFilter = (key, type) => {
	if (!key) {
		return;
	}
	try {
		if (type) {
			localStorage.setItem(key, type);
		} else {
			localStorage.removeItem(key);
		}
	} catch (error) {
		// Not saved; the selection still applies for this load.
	}
};

export default function createRecentlyViewedLayout(WidgetLayout, recentItems) {
	return class RecentlyViewedCuiLayout extends WidgetLayout {
		#root = null;
		#list = null;
		#toolbar = null;
		#filterButton = null;
		#filterLabel = null;
		#menu = null;
		#fallbackSelect = null;
		#optionsSignature = null;
		#items = [];
		// Access answers older than this are asked again (FRG_itemAccess.js).
		#accessSince = Date.now();
		#accessChecks = 0;

		async init() {
			// super.init() first: with location === '' it loads no CUI controls and
			// never binds this.dom, so the node stays ours. It also runs
			// _initializeState(), which puts widget_data (the Dashboard Widget
			// Template Props) into this.state.
			await super.init();
			injectStyles();
			this.#buildDom();
			this.addUnsubscriber(
				attachContextMenu({
					root: this.#root,
					targetSelector: '.rvw-row',
					// The service is one object per session on the main window. A
					// session that loaded an older copy (before this install, and
					// before a page reload) has no remove(): show no menu then.
					getItems: () =>
						typeof recentItems.remove === 'function'
							? { remove: { label: LABELS.remove } }
							: null,
					onSelect: (commandId, row) => {
						try {
							recentItems.remove(row.id);
						} catch (error) {
							reportActionError('[RecentlyViewed] remove failed', error);
						}
					}
				})
			);

			// Free for Core_GlobalLayout - the login bootstrap already holds the row,
			// so there is no request to wait on and no empty first paint.
			await recentItems.ensureLoaded();

			this.#items = recentItems.read();
			// After the read: restoring triggers a render, which would drop the
			// saved type as missing from a still-empty list.
			this.#restoreFilter();
			this.#render();
			this.addUnsubscriber(recentItems.subscribe(() => this.#onStoreChange()));
		}

		/**
		 * Reached only for changes to this widget's OWN layout state - i.e. the
		 * filter selection and any widget_data edit. The recents list arrives
		 * through #onStoreChange instead; see the header comment.
		 */
		updateLayout() {
			this.#render();
		}

		/**
		 * Enables "Refresh" in the widget burger menu. Must be defined directly on
		 * this class: the dashboard editor does not offer the item for an
		 * inherited refreshData.
		 *
		 * Commits anything pending to the server and repaints - it deliberately does
		 * NOT re-read. The stored copy lives on Core_GlobalLayout, which the client
		 * holds as a login-time snapshot, so there is no newer server state to fetch
		 * within a session; the in-memory list is always the freshest one.
		 */
		async refreshData() {
			this.#setStatus('loading');
			this.#accessSince = Date.now();
			try {
				recentItems.flushNow();
				this.#items = recentItems.read();
			} finally {
				if (!this.destroyed) {
					this.#setStatus('ready');
					this.#render();
				}
			}
		}

		// ------------------------------------------------------------------ data

		#onStoreChange() {
			if (this.destroyed) {
				return;
			}
			const next = recentItems.read();
			// Every write produces a new list object, so a reference compare is
			// enough and costs nothing on unrelated store updates.
			if (next === this.#items) {
				return;
			}
			this.#items = next;
			this.#render();
		}

		// Resolved on first use: the wrapper may not hold the node until after
		// the editor's first render.
		#filterStorageKey = null;

		#storageKey() {
			if (!this.#filterStorageKey) {
				this.#filterStorageKey = filterStorageKey(this.dom);
			}
			return this.#filterStorageKey;
		}

		/** Applies the selection saved by an earlier load of this widget. */
		#restoreFilter() {
			const saved = readSavedFilter(this.#storageKey());
			if (saved) {
				this.setState((state) => {
					state.filterType = saved;
				});
			}
		}

		#filterType() {
			return (this.state && this.state.filterType) || null;
		}

		/** The entries the user can still read, newest first. */
		#readableItems() {
			return readableEntries(this.#items, accessRef, this.#accessSince, (stale) =>
				this.#checkAccess(stale)
			);
		}

		#checkAccess(refs) {
			this.#accessChecks++;
			checkReadable(refs).finally(() => {
				this.#accessChecks--;
				if (!this.destroyed) {
					this.#render();
				}
			});
		}

		/** Hidden entries are left out before the cap, so they free their rows. */
		#visibleItems(readable) {
			const max = toPositiveInt(
				this.state && this.state.max_items,
				DEFAULT_MAX_ITEMS
			);
			const filter = this.#filterType();
			return readable.filter((item) => !filter || item.type === filter).slice(0, max);
		}

		#onFilterSelect(type) {
			writeSavedFilter(this.#storageKey(), type);
			this.setState((state) => {
				state.filterType = type;
			});
		}

		// ------------------------------------------------------------- rendering

		#buildDom() {
			const root = document.createElement('div');
			root.className = 'rvw';
			allowFormControls(root);

			const toolbar = document.createElement('div');
			toolbar.className = 'rvw__toolbar';

			const label = document.createElement('span');
			label.className = 'rvw__toolbar-label';
			label.textContent = LABELS.typeLabel;
			toolbar.appendChild(label);

			const list = document.createElement('ul');
			list.className = 'rvw__list';
			list.addEventListener('click', (event) => this.#onListClick(event));

			root.append(toolbar, list);
			this.dom.textContent = '';
			this.dom.appendChild(root);

			this.#root = root;
			this.#toolbar = toolbar;
			this.#list = list;
			this.#buildFilterControl();
		}

		/**
		 * Built from aras-dropdown + aras-button + aras-menu, like the widget burger
		 * menu, so the control looks native. Guarded: an undefined custom element
		 * renders as an inert unknown tag with no error, which would leave the
		 * widget unfilterable with nothing in the console.
		 */
		#buildFilterControl() {
			const hasComponents =
				customElements.get('aras-dropdown') &&
				customElements.get('aras-menu') &&
				customElements.get('aras-button');

			if (!hasComponents) {
				const select = document.createElement('select');
				select.className = 'rvw__filter-fallback';
				select.title = LABELS.filterTitle;
				select.addEventListener('change', () =>
					this.#onFilterSelect(
						select.value === ALL_TYPES_KEY ? null : select.value
					)
				);
				this.#fallbackSelect = select;
				this.#toolbar.appendChild(select);
				return;
			}

			const dropdown = document.createElement('aras-dropdown');
			dropdown.className = 'aras-dropdown-container';
			dropdown.setAttribute('position', 'bottom-left');
			dropdown.setAttribute('closeonclick', '');

			// button-a, NOT button-c: button-c is the icon-only mode and renders its
			// text transparent. button-a shows the label.
			const button = document.createElement('aras-button');
			button.setAttribute('mode', 'button-a');
			button.setAttribute('dropdown-button', '');
			button.title = LABELS.filterTitle;

			// The label lives in its own span rather than as the button's textContent:
			// aras-button slots its light DOM children, and rewriting textContent on
			// each render would drop the caret alongside it. ::slotted(:not(aras-image))
			// also gives element children their horizontal padding.
			const label = document.createElement('span');
			label.className = 'rvw__filter-value';

			const caret = document.createElement('span');
			caret.className = 'rvw__filter-caret';
			caret.setAttribute('aria-hidden', 'true');
			caret.textContent = '▾';

			button.append(label, caret);
			this.#filterLabel = label;

			const menu = document.createElement('aras-menu');
			menu.className = 'aras-dropdown';
			menu.addEventListener('click', (event) => {
				// Menu rows carry the map key on dataset.index.
				const row = event.target.closest('.aras-list-item');
				const key = row && row.dataset.index;
				if (key) {
					this.#onFilterSelect(key === ALL_TYPES_KEY ? null : key);
				}
			});

			dropdown.append(button, menu);
			this.#filterButton = button;
			this.#menu = menu;
			this.#toolbar.appendChild(dropdown);
		}

		#renderFilterControl(options) {
			const active = this.#filterType();
			const activeOption = active
				? options.find((option) => option.type === active)
				: null;
			const activeLabel = activeOption ? activeOption.label : LABELS.allTypes;
			const signature = optionsSignature(options);

			if (this.#fallbackSelect) {
				if (signature !== this.#optionsSignature) {
					this.#optionsSignature = signature;
					this.#fallbackSelect.textContent = '';
					[{ type: ALL_TYPES_KEY, label: LABELS.allTypes }, ...options].forEach(
						({ type, label }) => {
							const node = document.createElement('option');
							node.value = type;
							node.textContent = label;
							this.#fallbackSelect.appendChild(node);
						}
					);
				}
				this.#fallbackSelect.value = active || ALL_TYPES_KEY;
				return;
			}

			if (!this.#menu) {
				return;
			}

			if (this.#filterLabel) {
				this.#filterLabel.textContent = activeLabel;
			}
			this.#filterButton.title = LABELS.filterTitle + ': ' + activeLabel;

			if (signature === this.#optionsSignature) {
				return;
			}
			this.#optionsSignature = signature;

			const entries = [
				[ALL_TYPES_KEY, { label: LABELS.allTypes, icon: '' }],
				...options.map(({ type, label }) => [type, { label, icon: '' }])
			];
			this.#menu.applyData(
				new Map(entries),
				entries.map(([key]) => key)
			);
		}

		#render() {
			if (!this.#list) {
				return;
			}

			const readable = this.#readableItems();
			const options = buildTypeOptions(readable);
			this.#renderFilterControl(options);

			// A filter whose type has aged out of the list is dropped rather than
			// leaving the user staring at an empty widget with no obvious way back.
			// Not while the list is empty: nothing has aged out then, and dropping
			// it would wipe the saved filter too. Nor while access is being
			// checked: the type may only be missing because it is not confirmed yet.
			const checking = this.#accessChecks > 0;
			const active = this.#filterType();
			if (
				active &&
				!checking &&
				options.length > 0 &&
				!options.some((option) => option.type === active)
			) {
				this.#onFilterSelect(null);
				return;
			}

			const items = this.#visibleItems(readable);
			this.#removeMessage();

			if (items.length === 0 && checking) {
				// Nothing confirmed yet: no "Nothing viewed yet" message for a moment.
				this.#list.textContent = '';
				return;
			}

			if (items.length === 0) {
				const filtered = Boolean(active) && readable.length > 0;
				this.#list.textContent = '';
				this.#renderMessage(
					filtered ? LABELS.emptyFiltered : LABELS.empty,
					filtered ? LABELS.emptyFilteredHint : LABELS.emptyHint
				);
				return;
			}

			this.#preloadIcons(items);
			this.#list.textContent = '';
			items.forEach((item) => this.#list.appendChild(this.#buildRow(item)));
		}

		#buildRow(item) {
			const row = document.createElement('li');
			row.className = 'rvw-row';
			row.dataset.id = item.id;
			row.dataset.type = item.type;

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'rvw-row__button';
			button.title = LABELS.openHint(item.keyedName);

			const text = document.createElement('div');
			text.className = 'rvw-row__text';

			const name = document.createElement('div');
			name.className = 'rvw-row__name';
			name.textContent = item.keyedName;

			const meta = document.createElement('div');
			meta.className = 'rvw-row__meta';
			meta.textContent =
				(item.typeLabel || item.type) + ' - ' + formatAge(item.ts);

			text.append(name, meta);
			button.append(this.#buildIcon(item), text);
			row.appendChild(button);
			return row;
		}

		#buildIcon(item) {
			// Hand the icon value over exactly as stored ('../images/<name>.svg'):
			// SvgManager recognises icons in that form, and rewriting it to an
			// absolute URL would bypass its cache and force a plain <img>.
			if (customElements.get('aras-image')) {
				const image = document.createElement('aras-image');
				image.className = 'rvw-row__icon';
				image.setAttribute('aria-hidden', 'true');
				image.setAttribute('src', item.icon);
				return image;
			}

			const image = document.createElement('img');
			image.className = 'rvw-row__icon';
			image.alt = '';
			image.setAttribute('aria-hidden', 'true');
			try {
				image.src = new URL(item.icon, aras.getMainWindow().location.href).href;
			} catch (ignored) {
				image.src = '';
			}
			return image;
		}

		#preloadIcons(items) {
			const manager = window.ArasModules && window.ArasModules.SvgManager;
			if (!manager || typeof manager.load !== 'function') {
				return;
			}
			const urls = [...new Set(items.map((item) => item.icon).filter(Boolean))];
			if (urls.length === 0) {
				return;
			}
			// Fire and forget: icons are cosmetic and aras-image falls back on its own.
			manager.load(urls).catch((error) => {
				console.warn('[RecentlyViewed] icon preload failed', error);
			});
		}

		#renderMessage(title, hint) {
			const message = document.createElement('div');
			message.className = 'rvw__message';

			const titleNode = document.createElement('div');
			titleNode.className = 'rvw__message-title';
			titleNode.textContent = title;

			const hintNode = document.createElement('div');
			hintNode.className = 'rvw__message-hint';
			hintNode.textContent = hint;

			message.append(titleNode, hintNode);
			this.#root.appendChild(message);
		}

		#removeMessage() {
			const existing = this.#root.querySelector('.rvw__message');
			if (existing) {
				existing.remove();
			}
		}

		#setStatus(status) {
			if (this.#root) {
				this.#root.className =
					status === 'loading' ? 'rvw rvw_state-loading' : 'rvw';
			}
		}

		/**
		 * Opens the latest generation of the item (openLatestItem): an entry keeps
		 * the id of the generation that was opened, and the item may have been
		 * versioned since. The open itself is aras.uiShowItem, which re-fetches the
		 * item and runs the ItemType's OnShowItem event; a deleted or
		 * now-inaccessible item raises the standard "access restricted or does not
		 * exist" alert.
		 */
		#onListClick(event) {
			const row = event.target.closest('.rvw-row');
			if (!row || !row.dataset.id) {
				return;
			}
			openLatestItem(row.dataset.type, row.dataset.id);
		}
	};
}
