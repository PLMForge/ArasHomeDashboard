/**
 * Right-click menus for the FRG list and tile widgets.
 *
 * Built on Aras's own context menu, ArasModules.ContextMenu: an <aras-menu>
 * element with the aras-contextMenu class, styled by the client's common.css.
 * It is the same component the navigation panel and the classification editor
 * use, so the menu looks and behaves like every other context menu in the
 * client (Escape closes it, clicking elsewhere closes it, keyboard navigation
 * works). ArasModules is a global on the dashboard page in 14.0.25 and 14.35;
 * if it is missing, no menu is attached and the browser's own menu shows.
 *
 * Usage, from a widget's init():
 *
 *   this.addUnsubscriber(attachContextMenu({
 *       root,                          // the widget's own root node
 *       targetSelector: '.fvw-row',    // the element a menu belongs to
 *       getItems: (target) => ({ remove: { label: 'Remove', disabled: false } }),
 *       onSelect: (commandId, target) => { ... }
 *   }));
 *
 * getItems runs on every right-click, so labels and the disabled state can
 * depend on the clicked element. Returning null or an empty object shows no
 * menu (and leaves the browser's own menu alone). onSelect receives a snapshot
 * of the target's dataset, taken when the menu opened, so a re-render while
 * the menu is open does not change what the click acts on.
 */

export const attachContextMenu = ({ root, targetSelector, getItems, onSelect }) => {
	const ContextMenu = window.ArasModules && window.ArasModules.ContextMenu;
	if (!root || typeof ContextMenu !== 'function') {
		return () => {};
	}

	// One menu per widget, appended to this page's body like Aras's own.
	const menu = new ContextMenu();
	let currentItems = {};

	const offClick = menu.on('click', (commandId, event, target) => {
		const item = commandId && currentItems[commandId];
		if (!item || item.disabled || !target) {
			return;
		}
		onSelect(commandId, target);
	});

	const onContextMenu = (event) => {
		const node = event.target.closest(targetSelector);
		if (!node || !root.contains(node)) {
			return;
		}

		const target = { ...node.dataset };
		const items = getItems(target);
		if (!items || !Object.keys(items).length) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		// applyData merges into the menu's map, so start from an empty one.
		menu.data.clear();
		menu.applyData(items);
		currentItems = items;

		// The context-menu key and Shift+F10 report (0, 0); open the menu at the
		// element instead of in the corner of the page.
		let { clientX: x, clientY: y } = event;
		if (!x && !y) {
			const rect = node.getBoundingClientRect();
			x = rect.left + Math.min(24, rect.width / 2);
			y = rect.top + rect.height / 2;
		}
		menu.show({ x, y }, target);
	};

	root.addEventListener('contextmenu', onContextMenu);

	return () => {
		root.removeEventListener('contextmenu', onContextMenu);
		offClick();
		menu.dom.remove();
	};
};

/**
 * True when the favorite is in the session's client store. favorites.delete
 * only removes favorites it finds there and quietly does nothing for any
 * other id. A widget can show one that is not there after a manual Refresh
 * (e.g. a favorite added in another browser session), so the menu disables
 * its remove option for those rather than offering an action that does
 * nothing.
 */
export const isFavoriteInStore = (favoriteId) => {
	const store = aras.getMainWindow().store;
	return Boolean(favoriteId && store && store.getState().favorites[favoriteId]);
};

/**
 * Removes a favorite (a pinned ItemType or a favorited item) the way the
 * client's own menus do: favorites.delete. That removes it from the store at
 * once, so every widget and the navigation panel update together, and if the
 * server call fails it shows the client's own error and restores the entry.
 * Only an exception thrown past that is reported here.
 */
export const removeFavorite = async (favoriteId, logPrefix) => {
	try {
		return await aras.getMainWindow().favorites.delete(favoriteId);
	} catch (error) {
		reportActionError(logPrefix, error);
		return false;
	}
};

/**
 * Reports a failed action the way the client reports its own errors, falling
 * back to the console when the dialog API is unavailable.
 */
export const reportActionError = (prefix, error) => {
	console.error(prefix, error);
	const message = error && error.message ? error.message : String(error);
	try {
		aras.AlertError(message);
	} catch (ignored) {
		// The console entry above is the record.
	}
};
