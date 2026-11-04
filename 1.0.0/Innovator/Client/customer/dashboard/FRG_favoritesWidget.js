/**
 * "Favorites" - custom Dashboard Widget layout.
 *
 * Lists the items the user has marked as favorites (category 'Item', the star
 * on an item), across every ItemType, with a dropdown that filters by
 * ItemType. Looks and behaves like the Recently Viewed widget. Clicking a row
 * opens the item.
 *
 * Other favorite categories are left out: saved searches ('Search'), pinned
 * ItemTypes ('ItemType', shown by the Pinned ItemTypes widget) and saved grid
 * layouts ('Grid Layout').
 *
 * Data flow: favorites come from the client store shared by every window in
 * the session, through mapStateToProps -> updateLayout, so starring or
 * unstarring anything updates the widget live. (That works for the favorites
 * slice; see FRG_pinnedItemTypesWidget.js.) The filter is this widget's own
 * state, set with setState and saved to localStorage per user and per widget
 * so it survives a browser reload.
 *
 * The WidgetLayout base class is passed IN rather than imported: the dashboard
 * editor must see the very same class it already holds, and a separate import
 * could load a second copy of it (see FRG_registerWidgets.js).
 *
 * Registered by FRG_registerWidgets.js:
 *   addWidgetLayout({ Favorites: createFavoritesLayout(WidgetLayout) });
 *
 * Right-clicking a row offers Remove from Favorites, which deletes the
 * favorite the way the client's own menus do (see FRG_widgetContextMenu.js).
 *
 * Only favorites the user can still read are listed: one the user has lost
 * access to (a Mandatory Access Control policy, a permission change, a
 * deletion) is hidden, not removed, and comes back if access does
 * (FRG_itemAccess.js). Each load and Refresh asks the server again.
 */

import { attachContextMenu, isFavoriteInStore, removeFavorite } from './FRG_widgetContextMenu.js';
import { openLatestItem } from './FRG_itemVersions.js';
import { checkReadable, readableEntries } from './FRG_itemAccess.js';
import { allowFormControls } from './FRG_widgetInput.js';

const STYLE_ELEMENT_ID = 'favorites-widget-style';
const ALL_TYPES_KEY = '__all';
const ITEM_CATEGORY = 'Item';
const DEFAULT_ICON = '../images/DefaultItemType.svg';
// Server query returning the favorite items as JSON, in the same shape as the
// store: <FavoriteItems><Result>[...]</Result></FavoriteItems>.
const MAIN_WINDOW_INFO_METHOD = 'GetArasMainWindowInfo';
const FAVORITE_ITEMS_QUERY = 'GetFavoriteItems';
const FAVORITE_ITEMS_SECTION = 'FavoriteItems';

// English only. To translate, replace these with aras.getResource('', '<key>')
// lookups.
const LABELS = {
	empty: 'No favorites yet',
	emptyHint: 'Items you mark as favorites are listed here.',
	emptyFiltered: 'No favorites of this type',
	emptyFilteredHint: 'Choose a different type from the filter.',
	allTypes: 'All types',
	filterTitle: 'Filter by ItemType',
	typeLabel: 'Type',
	error: 'Could not refresh favorites',
	openHint: (name) => 'Open ' + name,
	remove: 'Remove from Favorites'
};

/**
 * Same look as the Recently Viewed widget, under its own `fvw` prefix.
 *
 * Colours: every value is a var(--token, light literal) expression using the
 * client's own colour tokens, so a theme that redefines those tokens restyles
 * the widget along with the rest of the client. Keep the light fallbacks: this
 * page does not define the tokens itself.
 */
const STYLES = `
.fvw {
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	font: 400 1rem/1.4 Roboto, 'Noto Sans JP', Arial, sans-serif;
	color: var(--gray900, #4f4f4f);
}
.fvw__toolbar {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--gray400, #dfdfdf);
}
.fvw__toolbar-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: .04em;
	opacity: .7;
}
.fvw__filter-caret {
	font-size: 10px;
	line-height: 1;
	opacity: .65;
}
.fvw__filter-fallback {
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
.fvw__list:empty {
	display: none;
}
.fvw__list {
	flex: 1 1 auto;
	overflow: auto;
	padding: 4px 0;
	margin: 0;
	list-style: none;
}
.fvw-row {
	display: block;
}
.fvw-row__button {
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
.fvw-row__button:hover {
	background-color: var(--gray300, #ebebeb);
}
.fvw-row__button:focus {
	outline: 0;
}
.fvw-row__button:focus-visible {
	border-left-color: var(--focus, #0f66cb);
	background-color: var(--gray300, #ebebeb);
}
.fvw-row__icon {
	height: 1.833rem;
	width: 1.833rem;
	flex-shrink: 0;
	display: block;
}
img.fvw-row__icon {
	object-fit: contain;
}
.fvw-row__text {
	min-width: 0;
	flex: 1 1 auto;
}
.fvw-row__name {
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.fvw-row__meta {
	font-size: 11px;
	opacity: .7;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.fvw__message {
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
.fvw__message-title {
	font-size: 13px;
	font-weight: 500;
}
.fvw__message-hint {
	padding-top: 4px;
	opacity: .75;
}
.fvw_state-loading {
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

/** Turns a failed ArasModules.soap call (often an XMLHttpRequest) into text. */
const describeSoapError = (error) => {
	if (typeof XMLHttpRequest === 'undefined' || !(error instanceof XMLHttpRequest)) {
		return error && error.message ? error.message : String(error);
	}
	let fault = '';
	try {
		const doc =
			error.responseXML ||
			new DOMParser().parseFromString(error.responseText || '', 'text/xml');
		const node = doc && doc.getElementsByTagName('faultstring')[0];
		fault = node && node.textContent ? node.textContent.trim() : '';
	} catch (ignored) {
		fault = '';
	}
	return fault || `HTTP ${error.status} ${error.statusText || ''}`.trim();
};

// ItemType name -> { label, icon }. ItemType metadata is cached by the client,
// so each type costs at most one lookup per page.
const typeInfoCache = new Map();

const getTypeInfo = (typeName) => {
	if (!typeInfoCache.has(typeName)) {
		let label = typeName;
		let icon = '';
		try {
			const node = aras.getItemTypeNodeForClient(typeName);
			if (node) {
				label = aras.getItemProperty(node, 'label') || typeName;
				icon = aras.getItemProperty(node, 'open_icon') || '';
			}
		} catch (ignored) {
			// Unknown or inaccessible ItemType: keep the name as the label.
		}
		typeInfoCache.set(typeName, { label, icon });
	}
	return typeInfoCache.get(typeName);
};

/** The favorite items, as display rows sorted by name. */
const buildEntries = (favorites) =>
	favorites
		.filter(
			(favorite) =>
				favorite &&
				favorite.category === ITEM_CATEGORY &&
				favorite.contextType &&
				favorite.additional_data &&
				favorite.additional_data.id
		)
		.map((favorite) => {
			const additionalData = favorite.additional_data;
			const typeInfo = getTypeInfo(favorite.contextType);
			return {
				favoriteId: favorite.id,
				type: favorite.contextType,
				typeLabel: typeInfo.label,
				name: favorite.label || additionalData.id || favorite.id,
				icon: additionalData.image || typeInfo.icon || DEFAULT_ICON,
				itemId: additionalData.id
			};
		})
		.sort(
			(a, b) =>
				a.name.localeCompare(b.name, undefined, { numeric: true }) ||
				a.typeLabel.localeCompare(b.typeLabel)
		);

const entriesAreEqual = (a, b) =>
	a.length === b.length &&
	a.every(
		(entry, index) =>
			entry.favoriteId === b[index].favoriteId &&
			entry.name === b[index].name &&
			entry.icon === b[index].icon
	);

/** Distinct ItemTypes present in the list, for the filter dropdown. */
const buildTypeOptions = (entries) => {
	const seen = new Map();
	entries.forEach((entry) => {
		if (!seen.has(entry.type)) {
			seen.set(entry.type, entry.typeLabel || entry.type);
		}
	});
	return [...seen.entries()]
		.map(([type, label]) => ({ type, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
};

const optionsSignature = (options) => options.map((option) => option.type).join('|');

// An Item favorite stores the item's config_id (see FRG_itemVersions.js).
const accessRef = (entry) => ({ type: entry.type, id: entry.itemId, configId: entry.itemId });

// ---------------------------------------------------------- saved filter
// The Type filter is kept in localStorage, per user and per widget, so it
// survives a browser reload. The widget part of the key is the Dashboard
// Widget relationship id, which the editor puts on the widget wrapper as
// data-id; the layout's own id is regenerated on every load and is useless
// here. The database name keeps instances on one host apart, since they share
// one localStorage, including a database cloned from another with the same
// widget ids. Without a wrapper or a user the filter simply is not saved.
const FILTER_STORAGE_PREFIX = 'FRG.Favorites.filterType';

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

/** @param {Function} WidgetLayout the dashboard editor's widget base class */
export default function createFavoritesLayout(WidgetLayout) {
	return class FavoritesCuiLayout extends WidgetLayout {
		#root = null;
		#list = null;
		#toolbar = null;
		#filterButton = null;
		#filterLabel = null;
		#menu = null;
		#fallbackSelect = null;
		#optionsSignature = null;
		#loadToken = 0;
		// Non-null only between a manual Refresh and the next store-driven props
		// change, as in the Pinned ItemTypes widget.
		#serverEntries = null;
		// Access answers older than this are asked again (FRG_itemAccess.js).
		#accessSince = Date.now();
		#accessChecks = 0;

		async init() {
			// super.init() first: with location === '' it loads no CUI controls and
			// never binds this.dom, so the node stays ours. It also fills this.props
			// through mapStateToProps before the first render.
			await super.init();
			injectStyles();
			this.#buildDom();
			this.addUnsubscriber(
				attachContextMenu({
					root: this.#root,
					targetSelector: '.fvw-row',
					getItems: (row) => ({
						remove: {
							label: LABELS.remove,
							disabled: !isFavoriteInStore(row.favoriteId)
						}
					}),
					onSelect: (commandId, row) =>
						removeFavorite(row.favoriteId, '[Favorites] remove failed')
				})
			);
			this.#restoreFilter();
			this.#render();
		}

		/**
		 * Returns the derived rows rather than the raw favorites map, so
		 * updateLayout runs only for changes that can alter what is shown.
		 */
		mapStateToProps(storeState) {
			const favorites = (storeState && storeState.favorites) || {};
			return { entries: buildEntries(Object.values(favorites)) };
		}

		/** Runs for favorites changes (props) and for filter changes (state). */
		updateLayout(prevProps) {
			const entries = (this.props && this.props.entries) || [];
			const prevEntries = (prevProps && prevProps.entries) || [];
			// A real favorites change outranks whatever a manual Refresh fetched.
			if (!prevProps || !entriesAreEqual(prevEntries, entries)) {
				this.#serverEntries = null;
			}
			this.#render();
		}

		/**
		 * Enables "Refresh" in the widget burger menu (it must be defined on this
		 * class; an inherited one is not offered).
		 *
		 * Re-asks the server, so a favorite added in another browser session
		 * shows up. The result is kept local: writing it into the shared store
		 * would let one widget overwrite the main window's favorites.
		 */
		async refreshData() {
			const token = ++this.#loadToken;
			this.#accessSince = Date.now();
			this.#setStatus('loading');
			try {
				const favorites = await this.#fetchFavorites();
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				this.#serverEntries = buildEntries(favorites);
				this.#setStatus('ready');
				this.#render();
			} catch (error) {
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				const detail = describeSoapError(error);
				// eslint-disable-next-line no-console
				console.error('[Favorites] refresh failed:', detail, error);
				this.#setStatus('ready');
				this.#list.textContent = '';
				this.#removeMessage();
				this.#renderMessage(LABELS.error, detail);
			}
		}

		// ------------------------------------------------------------------ data

		/** The favorites to list: those the user can still read. */
		#entries() {
			const entries = this.#serverEntries || (this.props && this.props.entries) || [];
			return readableEntries(entries, accessRef, this.#accessSince, (stale) =>
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

		async #fetchFavorites() {
			const body =
				`<Item type="Method" action="${MAIN_WINDOW_INFO_METHOD}">` +
				`<query_type>${FAVORITE_ITEMS_QUERY}</query_type>` +
				'</Item>';
			const result = await ArasModules.soap(body, {
				method: 'ApplyItem',
				async: true,
				headers: aras.getHttpHeadersForSoapMessage('ApplyItem'),
				url: aras.getServerURL()
			});
			const section = result && result.getElementsByTagName(FAVORITE_ITEMS_SECTION)[0];
			const node = section && section.getElementsByTagName('Result')[0];
			const text = node && node.textContent ? node.textContent.trim() : '';
			const parsed = text ? JSON.parse(text) : [];
			return Array.isArray(parsed) ? parsed : [];
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

		#onFilterSelect(type) {
			writeSavedFilter(this.#storageKey(), type);
			this.setState((state) => {
				state.filterType = type;
			});
		}

		// ------------------------------------------------------------- rendering

		#buildDom() {
			const root = document.createElement('div');
			root.className = 'fvw';
			allowFormControls(root);

			const toolbar = document.createElement('div');
			toolbar.className = 'fvw__toolbar';

			const label = document.createElement('span');
			label.className = 'fvw__toolbar-label';
			label.textContent = LABELS.typeLabel;
			toolbar.appendChild(label);

			const list = document.createElement('ul');
			list.className = 'fvw__list';
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
		 * aras-dropdown + aras-button + aras-menu, like the Recently Viewed
		 * filter, with a plain <select> if those elements are not defined.
		 */
		#buildFilterControl() {
			const hasComponents =
				customElements.get('aras-dropdown') &&
				customElements.get('aras-menu') &&
				customElements.get('aras-button');

			if (!hasComponents) {
				const select = document.createElement('select');
				select.className = 'fvw__filter-fallback';
				select.title = LABELS.filterTitle;
				select.addEventListener('change', () =>
					this.#onFilterSelect(select.value === ALL_TYPES_KEY ? null : select.value)
				);
				this.#fallbackSelect = select;
				this.#toolbar.appendChild(select);
				return;
			}

			const dropdown = document.createElement('aras-dropdown');
			dropdown.className = 'aras-dropdown-container';
			dropdown.setAttribute('position', 'bottom-left');
			dropdown.setAttribute('closeonclick', '');

			// button-a shows its label; button-c is icon-only.
			const button = document.createElement('aras-button');
			button.setAttribute('mode', 'button-a');
			button.setAttribute('dropdown-button', '');
			button.title = LABELS.filterTitle;

			const label = document.createElement('span');
			label.className = 'fvw__filter-value';

			const caret = document.createElement('span');
			caret.className = 'fvw__filter-caret';
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

			const allEntries = this.#entries();
			const options = buildTypeOptions(allEntries);
			this.#renderFilterControl(options);

			// A filter whose last favorite was removed is dropped rather than
			// leaving an empty widget with no obvious way back. Not while the list
			// is empty, though: that would also wipe a saved filter before the
			// favorites have arrived, nor while access is being checked: the type
			// may only be missing because its favorites are not confirmed yet.
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

			const entries = active
				? allEntries.filter((entry) => entry.type === active)
				: allEntries;
			this.#removeMessage();

			if (entries.length === 0 && checking) {
				// Nothing confirmed yet: no "No favorites" message for a moment.
				this.#list.textContent = '';
				return;
			}

			if (entries.length === 0) {
				const filtered = Boolean(active) && allEntries.length > 0;
				this.#list.textContent = '';
				this.#renderMessage(
					filtered ? LABELS.emptyFiltered : LABELS.empty,
					filtered ? LABELS.emptyFilteredHint : LABELS.emptyHint
				);
				return;
			}

			this.#preloadIcons(entries);
			this.#list.textContent = '';
			entries.forEach((entry) => this.#list.appendChild(this.#buildRow(entry)));
		}

		#buildRow(entry) {
			const row = document.createElement('li');
			row.className = 'fvw-row';
			row.dataset.itemId = entry.itemId;
			row.dataset.type = entry.type;
			row.dataset.favoriteId = entry.favoriteId;

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'fvw-row__button';
			button.title = LABELS.openHint(entry.name);

			const text = document.createElement('div');
			text.className = 'fvw-row__text';

			const name = document.createElement('div');
			name.className = 'fvw-row__name';
			name.textContent = entry.name;

			const meta = document.createElement('div');
			meta.className = 'fvw-row__meta';
			meta.textContent = entry.typeLabel;

			text.append(name, meta);
			button.append(this.#buildIcon(entry), text);
			row.appendChild(button);
			return row;
		}

		#buildIcon(entry) {
			// Hand the icon value over exactly as stored ('../images/<name>.svg'):
			// SvgManager recognises icons in that form, and rewriting it to an
			// absolute URL would bypass its cache and force a plain <img>.
			if (customElements.get('aras-image')) {
				const image = document.createElement('aras-image');
				image.className = 'fvw-row__icon';
				image.setAttribute('aria-hidden', 'true');
				image.setAttribute('src', entry.icon);
				return image;
			}

			const image = document.createElement('img');
			image.className = 'fvw-row__icon';
			image.alt = '';
			image.setAttribute('aria-hidden', 'true');
			try {
				image.src = new URL(entry.icon, aras.getMainWindow().location.href).href;
			} catch (ignored) {
				image.src = '';
			}
			return image;
		}

		#preloadIcons(entries) {
			const manager = window.ArasModules && window.ArasModules.SvgManager;
			if (!manager || typeof manager.load !== 'function') {
				return;
			}
			const urls = [...new Set(entries.map((entry) => entry.icon).filter(Boolean))];
			if (urls.length === 0) {
				return;
			}
			// Fire and forget: icons are cosmetic and aras-image falls back on its own.
			manager.load(urls).catch((error) => {
				// eslint-disable-next-line no-console
				console.warn('[Favorites] icon preload failed', error);
			});
		}

		#renderMessage(title, hint) {
			const message = document.createElement('div');
			message.className = 'fvw__message';

			const titleNode = document.createElement('div');
			titleNode.className = 'fvw__message-title';
			titleNode.textContent = title;

			const hintNode = document.createElement('div');
			hintNode.className = 'fvw__message-hint';
			hintNode.textContent = hint;

			message.append(titleNode, hintNode);
			this.#root.appendChild(message);
		}

		#removeMessage() {
			const existing = this.#root.querySelector('.fvw__message');
			if (existing) {
				existing.remove();
			}
		}

		#setStatus(status) {
			if (this.#root) {
				this.#root.className =
					status === 'loading' ? 'fvw fvw_state-loading' : 'fvw';
			}
		}

		/**
		 * Opens the item as the TOC's Favorites does. An Item favorite holds the
		 * item's config_id, which for a versionable ItemType is the id of its
		 * FIRST generation, so the latest generation is looked up first
		 * (openLatestItem). The open itself is aras.uiShowItem, which re-fetches
		 * the item and runs the ItemType's OnShowItem event; a deleted or
		 * now-inaccessible item raises the standard "access restricted or does not
		 * exist" alert.
		 */
		#onListClick(event) {
			const row = event.target.closest('.fvw-row');
			if (!row || !row.dataset.itemId) {
				return;
			}
			openLatestItem(row.dataset.type, row.dataset.itemId);
		}
	};
}
