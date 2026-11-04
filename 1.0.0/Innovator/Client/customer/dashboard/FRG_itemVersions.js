/**
 * Versionable items for the dashboard widgets: open the latest generation, and
 * tell which entries are generations of the same item.
 *
 * Every generation of a versionable item shares one config_id, which is also the
 * id of its first generation. Aras keeps Item favorites by config_id (the item
 * view's star compares additional_data.id with the item's config_id), so opening
 * a favorite by that id opens generation 1. The TOC's Favorites resolves it with
 * getItemLastVersion first (NavigationPanel _favoritesClick); openLatestItem does
 * the same, so the widgets open what the TOC opens.
 *
 * Each function takes the Aras object to use, defaulting to this window's: the
 * recent-items service lives on the main window and must use that one.
 */

const ambientAras = () => (typeof aras === 'undefined' ? null : aras);

/** True when the ItemType keeps generations. Client-cached metadata: no request. */
export const isVersionable = (type, arasObj = ambientAras()) => {
	if (!arasObj || !type) {
		return false;
	}
	try {
		const node = arasObj.getItemTypeNodeForClient(type);
		return Boolean(node) && arasObj.getItemProperty(node, 'is_versionable') === '1';
	} catch (ignored) {
		// Unknown or inaccessible ItemType: treat as not versionable.
		return false;
	}
};

/**
 * The id of the latest generation, or null if it cannot be read (deleted, no
 * access). One synchronous request, the one the TOC makes on a favorite click.
 * Any generation's id, or the config_id, works as input.
 */
export const latestVersionId = (type, id, arasObj = ambientAras()) => {
	if (!arasObj || !type || !id) {
		return null;
	}
	const latest = arasObj.getItemLastVersion(type, id, true);
	return (latest && latest.getAttribute('id')) || null;
};

/**
 * Opens the item in a tab: the latest generation for a versionable ItemType,
 * the item itself otherwise. Falls back to the given id when the latest cannot
 * be read, so a deleted or inaccessible item still raises the standard "access
 * restricted or does not exist" alert from uiShowItem.
 */
export const openLatestItem = (type, id, arasObj = ambientAras()) => {
	if (!arasObj || !type || !id) {
		return false;
	}
	const target = (isVersionable(type, arasObj) && latestVersionId(type, id, arasObj)) || id;
	return arasObj.uiShowItem(type, target);
};

/**
 * config_id of an item the client already holds (an opened item is in the items
 * cache), without a request. Non-versionable items are their own config. Returns
 * null when it is not known yet.
 */
export const knownConfigId = (type, id, itemNode = null, arasObj = ambientAras()) => {
	if (!id) {
		return null;
	}
	if (!isVersionable(type, arasObj)) {
		return id;
	}
	try {
		const node =
			itemNode || (arasObj && arasObj.itemsCache && arasObj.itemsCache.getItem(id));
		return (node && arasObj.getItemProperty(node, 'config_id')) || null;
	} catch (ignored) {
		return null;
	}
};

/** The key two entries share when they are generations of one item. */
export const versionKey = (entry) => (entry && (entry.configId || entry.id)) || '';
