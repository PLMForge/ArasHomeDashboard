/**
 * "PinnedItemTypes" - custom Dashboard Widget layout.
 *
 * Renders the current user's pinned ItemTypes as a tile grid that looks and
 * behaves like the tiles on the main window's start page, except that the tile
 * set comes from the user's ItemType favorites.
 *
 * Data flow:
 *   1. The widget reads favorites from the client store shared by every window
 *      in the session, so pinning or unpinning in the main window reaches the
 *      widget live through mapStateToProps -> updateLayout.
 *   2. Favorites with category 'ItemType' carry
 *      additional_data = { id, image, label, name }: exactly the ItemType id,
 *      icon and label a tile needs. There is deliberately no quickAccessFlag
 *      filter: pinned ItemTypes carry quickAccessFlag '0', so filtering on it
 *      would empty the widget.
 *   3. Clicking a tile opens the ItemType's search tab through the main
 *      window's arasTabs.
 *
 * Styling is inlined below because the page hosting the dashboard does not
 * load the main window's tile styles. The class prefix is `pit-` so nothing
 * collides with the client's own tile classes.
 *
 * Registered by FRG_registerWidgets.js:
 *   addWidgetLayout({ PinnedItemTypes: createPinnedItemTypesLayout(WidgetLayout) });
 *
 * The WidgetLayout base class is passed IN rather than imported here on
 * purpose: the dashboard editor must see the very same class it already holds,
 * and a separate import could load a second copy of it (see
 * FRG_registerWidgets.js).
 *
 * Right-clicking a tile offers Unpin, which removes the ItemType favorite the
 * same way the navigation panel does (see FRG_widgetContextMenu.js).
 */

import { attachContextMenu, isFavoriteInStore, removeFavorite } from './FRG_widgetContextMenu.js';

const STYLE_ELEMENT_ID = 'pinned-item-types-widget-style';
const ITEMTYPE_CATEGORY = 'ItemType';
const MAIN_WINDOW_INFO_METHOD = 'GetArasMainWindowInfo';
const FAVORITE_ITEM_TYPES_QUERY = 'GetFavoriteItemTypes';

// English only. To translate, replace these with aras.getResource('', '<key>')
// lookups.
const LABELS = {
	empty: 'No pinned ItemTypes',
	emptyHint: 'Pin an ItemType in the navigation panel to see it here.',
	error: 'Could not load pinned ItemTypes',
	openHint: (label) => `${label} - open search`,
	// Aras's own string, so the label matches the rest of the client.
	unpin: () => resource('common.unpin', 'Unpin')
};

/** aras.getResource with a fallback for a key this release does not have. */
const resource = (key, fallback) => {
	try {
		const text = aras.getResource('', key);
		return text && text !== key ? text : fallback;
	} catch (ignored) {
		return fallback;
	}
};

/**
 * Tile sizes match the main window's start-page tiles. The container differs
 * because a widget box is not a full page: tighter padding, and tiles pack from
 * the start instead of being centred.
 *
 * Colours: every value is a var(--token, light literal) expression using the
 * client's own colour tokens, so a theme that redefines those tokens restyles
 * the widget along with the rest of the client. Keep the light fallbacks: this
 * page does not define the tokens itself.
 *
 * 18.667rem is 224px at the client's base font size.
 */
const STYLES = `
.pit {
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	overflow: auto;
	display: flex;
	flex-direction: column;
}
.pit__container {
	padding: 12px;
	display: grid;
	grid-template-columns: repeat(auto-fill, 18.667rem);
	grid-gap: 16px;
	justify-content: start;
	align-content: start;
}
.pit-tile {
	width: 18.667rem;
	height: 4.667rem;
}
.pit-tile__button {
	cursor: pointer;
	background-color: var(--white, #ffffff);
	border: 1px solid var(--gray500, #cfcfcf);
	border-radius: 8px;
	padding: 12px;
	height: 100%;
	width: 100%;
	display: flex;
	align-items: center;
	gap: 12px;
	box-sizing: border-box;
}
.pit-tile__button:hover {
	background-color: var(--gray300, #ebebeb);
}
.pit-tile__button:focus {
	outline: 0;
}
.pit-tile__button:focus-visible {
	outline: 2px solid var(--focus, #0f66cb);
	border-color: transparent;
}
.pit-tile__button:active {
	background-color: var(--gray300, #ebebeb);
	border-color: var(--gray700, #878787);
}
.pit-tile__image {
	height: 2.667rem;
	width: 2.667rem;
	display: block;
	flex-shrink: 0;
}
/* Only reached on the <img> fallback: aras-image sizes its own inner node. */
img.pit-tile__image {
	object-fit: contain;
}
.pit-tile__label {
	font: 500 1.166667rem/1.2 Roboto, 'Noto Sans JP', Arial, sans-serif;
	color: var(--gray900, #4f4f4f);
	overflow: hidden;
	text-overflow: ellipsis;
	text-align: left;
	user-select: none;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
}
/* display: grid above outranks the hidden attribute, so restate it. */
.pit__container[hidden] {
	display: none;
}
/* Empty and error states take the tiles' place, centred both ways. */
.pit__message {
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
	color: var(--gray900, #4f4f4f);
}
.pit__message-title {
	font-size: 13px;
	font-weight: 500;
}
.pit__message-hint {
	padding-top: 4px;
	opacity: 0.75;
}
.pit__message_error .pit__message-title {
	color: var(--error-text, #cc2027);
}
.pit_state-loading {
	opacity: 0.5;
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

/**
 * Turns a failed ArasModules.soap call into a readable message. The rejection
 * value can be an XMLHttpRequest rather than an Error, so the SOAP faultstring
 * is read from the response when there is one.
 */
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

const toOrder = (value) => {
	const order = parseInt(value, 10);
	return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
};

/**
 * favoriteList -> ordered tile descriptors.
 *
 * Ordering matches the pinned strip in the navigation panel: favorite_order
 * first (drag-reordering writes it), then label as the tie-break.
 */
const buildTiles = (favoriteList) => {
	return favoriteList
		.filter((favorite) => favorite && favorite.category === ITEMTYPE_CATEGORY)
		.map((favorite) => {
			const data = favorite.additional_data || {};
			return {
				favoriteId: favorite.id,
				itemTypeId: data.id || '',
				label: data.label || data.name || '',
				icon: data.image || '',
				order: toOrder(favorite.favoriteOrder)
			};
		})
		.filter((tile) => Boolean(tile.itemTypeId))
		.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
};

const tilesAreEqual = (a, b) => {
	if (a.length !== b.length) {
		return false;
	}
	return a.every((tile, index) => {
		const other = b[index];
		return (
			tile.favoriteId === other.favoriteId &&
			tile.itemTypeId === other.itemTypeId &&
			tile.label === other.label &&
			tile.icon === other.icon
		);
	});
};

export default function createPinnedItemTypesLayout(WidgetLayout) {
	return class PinnedItemTypesCuiLayout extends WidgetLayout {
		#root = null;
		#container = null;
		#loadToken = 0;
		// Non-null only between a manual Refresh and the next store-driven props
		// change. Lets the burger-menu Refresh show server truth without writing
		// anything into the store the whole session shares.
		#serverTiles = null;

		async init() {
			// super.init() must run first: with location === '' it loads no CUI
			// controls and never binds this.dom, which leaves the node ours to own.
			// It also runs initializePropsAndState(), so this.props is populated by
			// mapStateToProps before we render.
			await super.init();
			injectStyles();
			this.#buildDom();
			this.addUnsubscriber(
				attachContextMenu({
					root: this.#root,
					targetSelector: '.pit-tile',
					getItems: (tile) => ({
						unpin: {
							label: LABELS.unpin(),
							disabled: !isFavoriteInStore(tile.favoriteId)
						}
					}),
					onSelect: (commandId, tile) =>
						removeFavorite(tile.favoriteId, '[PinnedItemTypes] unpin failed')
				})
			);
			await this.#preloadIcons(this.#currentTiles());
			this.#render();
		}

		/**
		 * The store slice this widget cares about. Returning the derived tile list
		 * rather than the raw favorites map means updateLayout runs only for
		 * changes that can actually alter what is on screen.
		 */
		mapStateToProps(storeState) {
			const favorites = (storeState && storeState.favorites) || {};
			return { tiles: buildTiles(Object.values(favorites)) };
		}

		async updateLayout(prevProps) {
			const tiles = this.props ? this.props.tiles : [];
			const prevTiles = prevProps ? prevProps.tiles : [];
			// A real favorites change outranks whatever a manual Refresh fetched.
			if (!prevProps || !tilesAreEqual(prevTiles, tiles)) {
				this.#serverTiles = null;
			}
			await this.#preloadIcons(this.#currentTiles());
			this.#render();
		}

		/**
		 * Enables the "Refresh" item in the widget burger menu.
		 *
		 * Re-asks the server for the favorites payload rather than just re-reading
		 * the store, so a pin made in a different browser session shows up. It
		 * uses the GetArasMainWindowInfo / GetFavoriteItemTypes request, whose
		 * JSON has the same shape as the favorites in the store.
		 *
		 * The result is deliberately kept local. Pushing it into the shared store
		 * would let one widget overwrite the main window's favorites state.
		 */
		async refreshData() {
			const token = ++this.#loadToken;
			this.#setStatus('loading');

			try {
				const favoriteList = await this.#fetchFavoriteItemTypes();
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}

				this.#serverTiles = favoriteList ? buildTiles(favoriteList) : null;
				await this.#preloadIcons(this.#currentTiles());
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				this.#setStatus('ready');
				this.#render();
			} catch (error) {
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				const detail = describeSoapError(error);
				// eslint-disable-next-line no-console
				console.error(
					'[PinnedItemTypes] refresh failed:',
					detail,
					error && error.responseText ? error.responseText : error
				);
				this.#setStatus('ready');
				this.#renderMessage(LABELS.error, detail, true);
			}
		}

		// ---------------------------------------------------------------- data

		#currentTiles() {
			return this.#serverTiles || (this.props && this.props.tiles) || [];
		}

		async #fetchFavoriteItemTypes() {
			const body =
				`<Item type="Method" action="${MAIN_WINDOW_INFO_METHOD}">` +
				`<query_type>${FAVORITE_ITEM_TYPES_QUERY}</query_type>` +
				'</Item>';
			const result = await ArasModules.soap(body, {
				method: 'ApplyItem',
				async: true,
				headers: aras.getHttpHeadersForSoapMessage('ApplyItem'),
				url: aras.getServerURL()
			});

			// The favorites are JSON text in FavoriteItemTypes/Result.
			const section = result && result.getElementsByTagName('FavoriteItemTypes')[0];
			const node = section && section.getElementsByTagName('Result')[0];
			const text = node && node.textContent ? node.textContent.trim() : '';
			if (!text) {
				return null;
			}

			const parsed = JSON.parse(text);
			return Array.isArray(parsed) ? parsed : null;
		}

		/**
		 * Hands the favorite icon value to SvgManager exactly as stored
		 * ('../images/<name>.svg'): SvgManager recognises icons in that form, so
		 * rewriting it to an absolute URL would bypass its cache. Preloading also
		 * resolves vault:///?fileid=... icons to real blob URLs.
		 */
		async #preloadIcons(tiles) {
			const manager = window.ArasModules && window.ArasModules.SvgManager;
			if (!manager || typeof manager.load !== 'function') {
				return;
			}

			const urls = [...new Set(tiles.map((tile) => tile.icon).filter(Boolean))];
			if (urls.length === 0) {
				return;
			}

			try {
				await manager.load(urls);
			} catch (error) {
				// Icons are cosmetic; aras-image falls back to a plain <img> and the
				// tiles still work.
				// eslint-disable-next-line no-console
				console.warn('[PinnedItemTypes] icon preload failed', error);
			}
		}

		// ------------------------------------------------------------ rendering

		#buildDom() {
			const root = document.createElement('div');
			root.className = 'pit';

			const container = document.createElement('div');
			container.className = 'pit__container';
			container.addEventListener('click', (event) => this.#onTileClick(event));

			root.appendChild(container);
			this.dom.textContent = '';
			this.dom.appendChild(root);

			this.#root = root;
			this.#container = container;
		}

		#setStatus(status) {
			if (this.#root) {
				this.#root.className = status === 'loading' ? 'pit pit_state-loading' : 'pit';
			}
		}

		#render() {
			if (!this.#container) {
				return;
			}

			const tiles = this.#currentTiles();
			if (tiles.length === 0) {
				this.#renderMessage(LABELS.empty, LABELS.emptyHint, false);
				return;
			}

			this.#container.textContent = '';
			this.#container.hidden = false;
			this.#removeMessage();
			tiles.forEach((tile) => this.#container.appendChild(this.#buildTile(tile)));
		}

		#renderMessage(title, hint, isError) {
			if (!this.#root || !this.#container) {
				return;
			}
			this.#container.textContent = '';
			this.#container.hidden = true;
			this.#removeMessage();

			const message = document.createElement('div');
			message.className = isError ? 'pit__message pit__message_error' : 'pit__message';

			const titleNode = document.createElement('div');
			titleNode.className = 'pit__message-title';
			titleNode.textContent = title;

			const hintNode = document.createElement('div');
			hintNode.className = 'pit__message-hint';
			hintNode.textContent = hint;

			message.append(titleNode, hintNode);
			this.#root.appendChild(message);
		}

		#removeMessage() {
			const existing = this.#root.querySelector('.pit__message');
			if (existing) {
				existing.remove();
			}
		}

		/**
		 * A data-id wrapper around a button holding the icon and a 2-line-clamped
		 * label.
		 */
		#buildTile(tile) {
			const node = document.createElement('div');
			node.className = 'pit-tile';
			node.dataset.id = tile.itemTypeId;
			node.dataset.favoriteId = tile.favoriteId;

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'pit-tile__button';
			button.setAttribute('aria-label', tile.label);
			button.title = LABELS.openHint(tile.label);

			const label = document.createElement('div');
			label.className = 'pit-tile__label';
			label.textContent = tile.label;

			button.append(this.#buildIcon(tile.icon, tile.label), label);
			node.appendChild(button);
			return node;
		}

		#buildIcon(icon, label) {
			// aras-image handles svg symbols, vault images and plain files. If the
			// element is not defined on this page, fall back to a plain <img>; an
			// undefined <aras-image> would render no icon at all.
			if (customElements.get('aras-image')) {
				const image = document.createElement('aras-image');
				image.className = 'pit-tile__image';
				image.setAttribute('aria-hidden', 'true');
				image.setAttribute('src', icon);
				return image;
			}

			const image = document.createElement('img');
			image.className = 'pit-tile__image';
			image.alt = '';
			image.setAttribute('aria-hidden', 'true');
			image.src = this.#resolveIconUrl(icon);
			return image;
		}

		/**
		 * Fallback path only. Favorite icons are stored relative to the *main
		 * window* document ('../images/Part.svg'); this page sits at a different
		 * depth, so a raw src would 404. Vault icons have no URL until SvgManager
		 * has resolved them.
		 */
		#resolveIconUrl(icon) {
			if (!icon) {
				return '';
			}

			const manager = window.ArasModules && window.ArasModules.SvgManager;
			if (manager && /vault:\/\/\/\?fileid=/i.test(icon)) {
				return manager.getVaultImageSrc(icon) || '';
			}

			try {
				return new URL(icon, aras.getMainWindow().location.href).href;
			} catch (ignored) {
				return icon;
			}
		}

		/**
		 * Opens the ItemType's search tab through the main window's arasTabs, as
		 * a start-page tile does.
		 */
		#onTileClick(event) {
			const target = event.target.closest('.pit-tile__button');
			if (!target) {
				return;
			}

			const tile = target.closest('.pit-tile');
			const itemTypeId = tile && tile.dataset.id;
			if (!itemTypeId) {
				return;
			}

			const mainWindow = aras.getMainWindow();
			if (!mainWindow || !mainWindow.arasTabs) {
				// eslint-disable-next-line no-console
				console.warn('[PinnedItemTypes] main window tabs unavailable');
				return;
			}

			mainWindow.arasTabs.openSearch(itemTypeId);
		}
	};
}
