/**
 * FRG_registerWidgets.js
 *
 * Registers the FRG custom dashboard widgets with the Aras dashboard editor.
 *
 * This file exists so that dashboardEditorView.cshtml only ever carries a few
 * lines that call into here. Everything else lives in this file, which the
 * FRG_DashboardWidgets package owns outright and overwrites on install.
 *
 * WHY THE API IS PASSED IN RATHER THAN IMPORTED
 * The dashboard editor checks that each widget layout extends its own
 * WidgetLayout class. Importing the dashboard module again from here could
 * load a SECOND copy of that class, and the widgets would then silently never
 * render. The caller already holds the correct bindings and hands them over.
 * Do not add an import of the dashboard module.
 *
 * CACHE BUSTING
 * There is none in this file, deliberately. The view imports this module through
 * a URL that carries the client cache salt, and the relative imports below
 * inherit it. The installer bumps filesRevision in InnovatorClient.config on
 * every deploy, which changes the salt and so retires every one of these URLs
 * at once. Never add a manual ?v= here.
 */

/**
 * @param {object} api
 * @param {Function} api.addWidgetLayout   dashboard editor API
 * @param {Function} api.addFormCustomizer dashboard editor API
 * @param {Function} api.WidgetLayout      dashboard editor widget base class
 */
export async function registerAll(api) {
	const { addWidgetLayout, addFormCustomizer, WidgetLayout } = api;

	if (!addWidgetLayout || !WidgetLayout) {
		console.error(
			'[FRG] registerAll called without the dashboard API; no widgets registered'
		);
		return;
	}

	await loadInBasketCounts(addWidgetLayout, addFormCustomizer, WidgetLayout);
	await loadPinnedItemTypes(addWidgetLayout, WidgetLayout);
	await loadRecentlyViewed(addWidgetLayout, WidgetLayout);
	await loadFavorites(addWidgetLayout, WidgetLayout);
	await loadQuickFind(addWidgetLayout, WidgetLayout);
}

async function loadInBasketCounts(addWidgetLayout, addFormCustomizer, WidgetLayout) {
	try {
		const { default: createInBasketCountsLayout, inBasketCountsFormCustomizer } =
			await import('./FRG_inBasketCountsWidget.js');

		addWidgetLayout({
			InBasketCounts: createInBasketCountsLayout(WidgetLayout)
		});
		// Without this the widget's settings fields render unstyled.
		addFormCustomizer({ InBasketCounts: inBasketCountsFormCustomizer });
	} catch (ex) {
		console.error('[FRG][InBasketCounts] registration failed', ex);
	}
}

async function loadPinnedItemTypes(addWidgetLayout, WidgetLayout) {
	try {
		const { default: createPinnedItemTypesLayout } = await import(
			'./FRG_pinnedItemTypesWidget.js'
		);

		addWidgetLayout({
			PinnedItemTypes: createPinnedItemTypesLayout(WidgetLayout)
		});
	} catch (ex) {
		console.error('[FRG][PinnedItemTypes] registration failed', ex);
	}
}

async function loadRecentlyViewed(addWidgetLayout, WidgetLayout) {
	try {
		// THIS getRecentItems() CALL IS THE CAPTURE'S INSTALL TRIGGER.
		//
		// The package does not edit the main page, so nothing installs the
		// recently-viewed capture at login -- this call does it, the first time a
		// dashboard editor opens. Keep it eager: making it lazy (resolving the
		// service only when a RecentlyViewed widget initialises) would mean nothing
		// records anything on a dashboard that has no such widget.
		//
		// getRecentItems() is a main-window singleton
		// (mainWindow.customerRecentItems ??= create(mainWindow)), so calling it
		// from a tab is safe and repeat calls are free. Its first scan() sweeps the
		// entire current tab list, so every item still open at this moment is
		// captured retroactively; only items opened AND closed earlier in the
		// session are lost.
		const [{ getRecentItems }, { default: createRecentlyViewedLayout }] =
			await Promise.all([
				import('./FRG_recentItems.js'),
				import('./FRG_recentlyViewedWidget.js')
			]);

		addWidgetLayout({
			RecentlyViewed: createRecentlyViewedLayout(WidgetLayout, getRecentItems())
		});
	} catch (ex) {
		console.error('[FRG][RecentlyViewed] registration failed', ex);
	}
}

async function loadFavorites(addWidgetLayout, WidgetLayout) {
	try {
		const { default: createFavoritesLayout } = await import(
			'./FRG_favoritesWidget.js'
		);

		addWidgetLayout({
			Favorites: createFavoritesLayout(WidgetLayout)
		});
	} catch (ex) {
		console.error('[FRG][Favorites] registration failed', ex);
	}
}

async function loadQuickFind(addWidgetLayout, WidgetLayout) {
	try {
		const { default: createQuickFindLayout } = await import('./FRG_quickFindWidget.js');

		addWidgetLayout({
			QuickFind: createQuickFindLayout(WidgetLayout)
		});
	} catch (ex) {
		console.error('[FRG][QuickFind] registration failed', ex);
	}
}
