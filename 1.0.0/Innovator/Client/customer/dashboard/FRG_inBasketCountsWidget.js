/**
 * "InBasketCounts" — custom Dashboard Widget layout.
 *
 * Shows two numbers for the logged-in user's *Active* InBasket workflow tasks:
 *   - Direct : assignments whose related_id is the user's own alias Identity
 *   - Group  : total - direct (i.e. reached via a group Identity membership)
 *
 * Data flow:
 *   1. GetAssignedTasks('Active', workflow=1, project=0, action=0) returns the
 *      legacy grid XML. Every workflow row carries <userdata key="assignmentID">.
 *   2. Those assignment ids are re-queried in chunks with related_id = alias
 *      identity. The match count is "direct".
 *   3. group = total - direct.
 *
 * Deriving both halves from the same GetAssignedTasks payload is deliberate:
 * the total and the split can never disagree, and the widget never has to
 * re-implement the server's Active/Pending rules.
 *
 * Fallback: if GetAssignedTasks fails or does not exist, the counts come from
 * the InBasket Task ItemType instead (status Active, my_assignment 1, workflow
 * tasks only). "direct" is then the tasks whose assigned_to is the alias
 * identity, and "group" is the rest.
 *
 * Clicking a number opens the InBasket with a Favorite search. When the widget
 * settings name no favorite the user can see, the widget creates the user's
 * own "Assigned to Me" / "Assigned to Group" favorite on the first click and
 * reuses it afterwards (see #openInBasket).
 *
 * Project activities and FMEA action items are intentionally excluded — they do
 * not use Activity Assignment, so they would inflate the total without ever
 * being classifiable as direct.
 *
 * Registered by FRG_registerWidgets.js:
 *   addWidgetLayout({ InBasketCounts: createInBasketCountsLayout(WidgetLayout) });
 *
 * The WidgetLayout base class is passed IN rather than imported here on purpose:
 * the dashboard editor must see the very same class it already holds, and a
 * separate import could load a second copy of it (see FRG_registerWidgets.js).
 */

const VIEW_MODE = 'Active';
const ID_CHUNK_SIZE = 250;
const STYLE_ELEMENT_ID = 'inbasket-counts-widget-style';
const GUID = /^[0-9A-Fa-f]{32}$/;
const PROJECT_SOLUTION = 'com.aras.innovator.solution.Project';
const INBASKET_ITEMTYPE = 'InBasket Task';
const WORKFLOW_TASK_ITEMTYPE = 'Workflow Task';
// Widget template prop names holding the chosen Favorite search per button.
const FAVORITE_PROPS = {
	direct: 'favorite_direct_id',
	group: 'favorite_group_id'
};
// The Favorite search each button creates for the user on first click when no
// usable favorite is configured for it. A user's existing favorite with the
// same label is reused instead, so a second one is never created.
const GENERATED_FAVORITES = {
	direct: { label: 'Assigned to Me', condition: 'eq' },
	group: { label: 'Assigned to Group', condition: 'ne' }
};
// Id of the "NoUI" SearchMode that Aras ships (labelled "Hidden"). A search
// saved in it opens with the results only: no filter row and no AML editor.
// That also lets the criteria use the alias identity's id, which Simple mode
// cannot show (and 14.0.25's Simple mode cannot show "is not" at all).
const HIDDEN_SEARCH_MODE_ID = '95A2002E5AD84B9D8B2FA50B742C5973';
// Columns the InBasket search grid selects, saved with the criteria in the
// same way as a search saved from the grid.
const INBASKET_SELECT =
	'icon,itemtype,container,name,start_date,due_date,status,assigned_to,instructions,item,my_assignment';

/** Reads the user's favorites from the client store on the main window. */
const getFavorites = () => {
	try {
		const mainWindow = aras.getMainWindow();
		const state = mainWindow && mainWindow.store && mainWindow.store.getState();
		return (state && state.favorites) || {};
	} catch (ignored) {
		return {};
	}
};

/** True for a Search favorite saved against the InBasket Task main grid. */
const isInBasketSearchFavorite = (favorite) =>
	Boolean(favorite) &&
	favorite.category === 'Search' &&
	favorite.contextType === INBASKET_ITEMTYPE &&
	(favorite.additional_data || {}).location === 'Main Grid';

/** Saved searches selectable for these buttons. */
const getInBasketSearchFavorites = () =>
	Object.values(getFavorites())
		.filter(isInBasketSearchFavorite)
		.map((favorite) => ({ label: favorite.label || '', value: favorite.id }))
		.sort((a, b) => a.label.localeCompare(b.label));

/**
 * The search behind a generated favorite: active tasks the user can act on,
 * assigned to the alias identity ("direct") or to any other identity, i.e. a
 * group ("group"). This is the same split the counts use. Matching the id
 * rather than the keyed name keeps the search valid if the user is renamed.
 */
const buildFavoriteCriteria = (mode, aliasId) =>
	`<Item type="${INBASKET_ITEMTYPE}" action="get" page="1" select="${INBASKET_SELECT}" pagesize="25" maxRecords="" returnMode="itemsOnly">` +
	`<status condition="eq">${VIEW_MODE}</status>` +
	'<my_assignment condition="eq">1</my_assignment>' +
	`<assigned_to condition="${GENERATED_FAVORITES[mode].condition}">${aliasId}</assigned_to>` +
	'</Item>';

/** The user's own favorite for this button, if they already have one. */
const findOwnFavorite = (mode, aliasId) =>
	Object.values(getFavorites()).find(
		(favorite) =>
			isInBasketSearchFavorite(favorite) &&
			favorite.label === GENERATED_FAVORITES[mode].label &&
			favorite.ownedBy === aliasId
	);

/**
 * Creates the favorite with the client favorites API, the same call the
 * search grid's "save search" dialog makes. The server side is the stock
 * Fav_AddFavoriteItem method, which also creates the SavedSearch.
 */
const createFavorite = async (mode, aliasId) => {
	const mainWindow = aras.getMainWindow();
	const favoritesApi = mainWindow && mainWindow.favorites;
	if (!favoritesApi || typeof favoritesApi.add !== 'function') {
		throw new Error('the client favorites API is unavailable');
	}

	const { label } = GENERATED_FAVORITES[mode];
	const favorite = await favoritesApi.add('Search', {
		id: aras.generateNewGUID(),
		contextType: INBASKET_ITEMTYPE,
		label,
		quickAccessFlag: '0',
		ownedBy: aliasId,
		mustViewById: aliasId,
		additional_data: {
			id: aras.generateNewGUID(), // the SavedSearch
			itname: INBASKET_ITEMTYPE,
			label,
			location: 'Main Grid',
			search_mode: HIDDEN_SEARCH_MODE_ID,
			criteria: buildFavoriteCriteria(mode, aliasId),
			owned_by_id: aliasId,
			show_on_toc: '0',
			auto_saved: '0'
		}
	});
	if (!favorite || !favorite.id) {
		throw new Error('the server did not save the favorite');
	}

	// eslint-disable-next-line no-console
	console.info(`[InBasketCounts] created the Favorite search "${label}"`);
	return favorite.id;
};

// Creations in progress, so a double click creates only one favorite.
const pendingFavorites = {};

/** Id of the user's favorite for this button, creating it on first use. */
const getOrCreateFavorite = (mode) => {
	const aliasId = aras.getIsAliasIdentityIDForLoggedUser();
	if (!GUID.test(String(aliasId || ''))) {
		return Promise.reject(new Error('No alias Identity for the logged-in user.'));
	}

	const existing = findOwnFavorite(mode, aliasId);
	if (existing) {
		return Promise.resolve(existing.id);
	}

	if (!pendingFavorites[mode]) {
		pendingFavorites[mode] = createFavorite(mode, aliasId).finally(() => {
			delete pendingFavorites[mode];
		});
	}
	return pendingFavorites[mode];
};

// Resolved once per page load, shared by every widget instance.
let projectTasksFlagPromise = null;

// Set when GetAssignedTasks fails; from then on every widget instance on this
// page counts from the InBasket Task ItemType instead.
let useInBasketTaskFallback = false;

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

// English only. To translate, replace these with aras.getResource('', '<key>')
// lookups.
const LABELS = {
	direct: 'Assigned to me',
	group: 'Assigned to my groups',
	total: (n) => `${n} active task${n === 1 ? '' : 's'}`,
	loading: 'Loading…',
	error: 'Could not load InBasket tasks',
	partial: 'Some rows could not be classified',
	openHint: (what) => `${what} — open in InBasket`
};

/*
 * Text inherits html { color: var(--text) } from common.css. Hover matches the
 * stock tile/grid-row hover (@gray300), focus and error use the stock tokens.
 * Colours: every value is a var(--token, light literal) expression using the
 * client's own colour tokens, so a theme that redefines those tokens restyles
 * the widget along with the rest of the client. The light literal fallback is
 * load-bearing: this page does not load default.css, so --white / --grayN /
 * --focus are otherwise undefined here.
 */
const STYLES = `
.ibc {
	display: flex;
	flex-direction: column;
	justify-content: center;
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	padding: 12px 16px;
	font-family: inherit;
	color: inherit;
}
.ibc__body {
	display: flex;
	align-items: stretch;
	justify-content: space-around;
	flex: 1 1 auto;
	min-height: 0;
	gap: 8px;
}
.ibc__stat {
	display: flex;
	flex: 1 1 0;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	min-width: 0;
	gap: 2px;
	/* button reset */
	margin: 0;
	padding: 6px 4px;
	border: 0;
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
	transition: background-color 0.12s ease;
}
.ibc__stat:hover {
	background: var(--gray300, #ebebeb);
}
.ibc__stat:focus-visible {
	outline: 2px solid var(--focus, #0f66cb);
	outline-offset: -2px;
}
.ibc_state-loading .ibc__stat,
.ibc_state-error .ibc__stat {
	cursor: default;
}
.ibc__value {
	font-size: clamp(24px, 14cqw, 48px);
	font-weight: 600;
	line-height: 1.1;
	font-variant-numeric: tabular-nums;
}
.ibc__label {
	font-size: 12px;
	line-height: 1.3;
	text-align: center;
	opacity: 0.65;
	overflow-wrap: anywhere;
}
.ibc__divider {
	flex: 0 0 1px;
	align-self: center;
	width: 1px;
	height: 60%;
	background: currentColor;
	opacity: 0.15;
}
.ibc__footer {
	flex: 0 0 auto;
	padding-top: 8px;
	font-size: 11px;
	text-align: center;
	opacity: 0.55;
}
.ibc_state-loading .ibc__body,
.ibc_state-error .ibc__body {
	opacity: 0.45;
}
.ibc__message {
	flex: 0 0 auto;
	padding-top: 6px;
	font-size: 11px;
	text-align: center;
	opacity: 0.8;
}
.ibc__message_error {
	color: var(--error-text, #cc2027);
	opacity: 1;
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

export default function createInBasketCountsLayout(WidgetLayout) {
	return class InBasketCountsCuiLayout extends WidgetLayout {
		#refs = null;
		#loadToken = 0;
		#timerId = null;

		async init() {
			// super.init() must run first: with location === '' it loads no CUI
			// controls and never binds this.dom, which leaves the node ours to own.
			await super.init();
			injectStyles();
			this.#buildDom();
			this.#startAutoRefresh();
			await this.refreshData();
		}

		updateLayout() {
			this.#render();
		}

		/** Enables the "Refresh" item in the widget burger menu. */
		async refreshData() {
			const token = ++this.#loadToken;
			this.setState((state) => {
				state.status = 'loading';
			});

			try {
				const counts = await this.#loadCounts();
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				this.setState((state) => {
					state.status = 'ready';
					state.error = null;
					state.direct = counts.direct;
					state.group = counts.group;
					state.total = counts.total;
					state.partial = counts.partial;
				});
			} catch (error) {
				if (this.destroyed || token !== this.#loadToken) {
					return;
				}
				const detail = describeSoapError(error);
				// eslint-disable-next-line no-console
				console.error(
					'[InBasketCounts] load failed:',
					detail,
					error && error.responseText ? error.responseText : error
				);
				this.setState((state) => {
					state.status = 'error';
					state.error = detail;
				});
			}
		}

		/**
		 * Enables the "Open in Tab" item in the widget burger menu. The dashboard
		 * editor offers the item only when this method exists, so keep it declared
		 * even though the body is trivial.
		 */
		async openInTab() {
			this.#openInBasket(null);
		}

		destroy() {
			this.#stopAutoRefresh();
			super.destroy();
		}

		// ---------------------------------------------------------------- data

		/**
		 * Counts through GetAssignedTasks, falling back to the InBasket Task
		 * ItemType when that server action fails or does not exist. On some
		 * releases (for example 14.0.25 without the Project solution) it fails
		 * for every combination of flags. Once it has failed, the rest of the
		 * page session uses the fallback, so the failing call is not repeated on
		 * every refresh.
		 */
		async #loadCounts() {
			const aliasId = aras.getIsAliasIdentityIDForLoggedUser();
			if (!GUID.test(String(aliasId || ''))) {
				throw new Error('No alias Identity for the logged-in user.');
			}

			if (!useInBasketTaskFallback) {
				try {
					return await this.#countFromAssignedTasks(aliasId);
				} catch (error) {
					useInBasketTaskFallback = true;
					// eslint-disable-next-line no-console
					console.warn(
						'[InBasketCounts] GetAssignedTasks failed; counting from ' +
							INBASKET_ITEMTYPE +
							' instead:',
						describeSoapError(error)
					);
				}
			}

			return this.#countFromInBasketTasks(aliasId);
		}

		async #countFromAssignedTasks(aliasId) {
			const { rowCount, assignmentIds } = await this.#getActiveAssignments();
			if (rowCount === 0) {
				return { total: 0, direct: 0, group: 0, partial: false };
			}

			const direct = await this.#countDirect(assignmentIds, aliasId);

			return {
				total: rowCount,
				direct,
				group: Math.max(0, rowCount - direct),
				// Rows without an assignmentID cannot be classified; they still count
				// toward the total, so they land in "group" by subtraction.
				partial: assignmentIds.length !== rowCount
			};
		}

		/**
		 * GetAssignedTasks' projectTasks flag: 0 when the Project solution is
		 * installed (its tasks are excluded), -1 when it is not installed at all.
		 * Passing 0 on an install without the solution makes the call fail.
		 */
		#getProjectTasksFlag() {
			if (!projectTasksFlagPromise) {
				const aml =
					'<Item type="PackageDefinition" action="get" select="id">' +
					`<name>${PROJECT_SOLUTION}</name>` +
					'</Item>';
				projectTasksFlagPromise = this.#soap('ApplyItem', aml)
					.then((result) =>
						result && result.getElementsByTagName('Item').length > 0 ? 0 : -1
					)
					.catch(() => -1);
			}

			return projectTasksFlagPromise;
		}

		/**
		 * Calls GetAssignedTasks and pulls the assignment ids out of the grid XML
		 * it returns:
		 *   <table><tr id=".."><userdata key="assignmentID" value=".."/>..</tr></table>
		 */
		async #getActiveAssignments() {
			const projectTasks = await this.#getProjectTasksFlag();
			const body =
				'<params>' +
				`<inBasketViewMode>${VIEW_MODE}</inBasketViewMode>` +
				'<workflowTasks>1</workflowTasks>' +
				`<projectTasks>${projectTasks}</projectTasks>` +
				'<actionTasks>0</actionTasks>' +
				'</params>';

			const result = await this.#soap('GetAssignedTasks', body);
			const payloadNode = result && result.getElementsByTagName('Item')[0];
			const payload = payloadNode ? payloadNode.textContent : '';
			if (!payload || !payload.trim()) {
				return { rowCount: 0, assignmentIds: [] };
			}

			const doc = new DOMParser().parseFromString(payload, 'text/xml');
			if (doc.getElementsByTagName('parsererror').length > 0) {
				throw new Error('Unexpected GetAssignedTasks response format.');
			}

			const rowCount = doc.getElementsByTagName('tr').length;
			const assignmentIds = [];
			doc
				.querySelectorAll('tr > userdata[key="assignmentID"]')
				.forEach((node) => {
					const value = node.getAttribute('value');
					if (GUID.test(String(value || ''))) {
						assignmentIds.push(value);
					}
				});

			return { rowCount, assignmentIds };
		}

		/** Counts how many of the given assignments point at the alias identity. */
		async #countDirect(assignmentIds, aliasId) {
			let direct = 0;

			for (let i = 0; i < assignmentIds.length; i += ID_CHUNK_SIZE) {
				const chunk = assignmentIds.slice(i, i + ID_CHUNK_SIZE);
				const idList = chunk.map((id) => `'${id}'`).join(',');
				const aml =
					'<Item type="Activity Assignment" action="get" select="id">' +
					`<id condition="in">${idList}</id>` +
					`<related_id>${aliasId}</related_id>` +
					'</Item>';

				const result = await this.#soap('ApplyItem', aml);
				if (this.destroyed) {
					return direct;
				}
				direct += result ? result.getElementsByTagName('Item').length : 0;
			}

			return direct;
		}

		/**
		 * Fallback count from the InBasket Task ItemType, which is what the stock
		 * My InBasket search uses. my_assignment=1 keeps only tasks assigned to
		 * the user or to a group they belong to. The itemtype filter keeps only
		 * workflow tasks, matching the GetAssignedTasks path (project activities
		 * and FMEA action items are excluded there too).
		 */
		async #countFromInBasketTasks(aliasId) {
			const workflowTaskTypeId = aras.getItemTypeId(WORKFLOW_TASK_ITEMTYPE);
			const typeFilter = GUID.test(String(workflowTaskTypeId || ''))
				? `<itemtype>${workflowTaskTypeId}</itemtype>`
				: '';
			const aml =
				`<Item type="${INBASKET_ITEMTYPE}" action="get" select="assigned_to">` +
				`<status>${VIEW_MODE}</status>` +
				'<my_assignment>1</my_assignment>' +
				typeFilter +
				'</Item>';

			const result = await this.#soap('ApplyItem', aml);
			const tasks = result
				? Array.from(result.getElementsByTagName('Item')).filter(
						(node) => node.getAttribute('type') === INBASKET_ITEMTYPE
				  )
				: [];

			let direct = 0;
			for (const task of tasks) {
				const assignedTo = task.getElementsByTagName('assigned_to')[0];
				if (assignedTo && assignedTo.textContent.trim() === aliasId) {
					direct++;
				}
			}

			return {
				total: tasks.length,
				direct,
				group: tasks.length - direct,
				partial: false
			};
		}

		/** Asynchronous SOAP call to the Innovator server. */
		#soap(method, body) {
			return ArasModules.soap(body, {
				method,
				async: true,
				headers: aras.getHttpHeadersForSoapMessage(method),
				url: aras.getServerURL()
			});
		}

		// -------------------------------------------------------------- refresh

		#startAutoRefresh() {
			const seconds = Number(this.state.refresh_interval);
			if (!Number.isFinite(seconds) || seconds <= 0) {
				return;
			}
			this.#timerId = window.setInterval(
				() => this.refreshData(),
				Math.max(30, seconds) * 1000
			);
		}

		#stopAutoRefresh() {
			if (this.#timerId !== null) {
				window.clearInterval(this.#timerId);
				this.#timerId = null;
			}
		}

		// ------------------------------------------------------------ rendering

		#buildDom() {
			const root = document.createElement('div');
			root.className = 'ibc';

			const body = document.createElement('div');
			body.className = 'ibc__body';

			const directStat = this.#buildStat(LABELS.direct, 'direct');
			const divider = document.createElement('div');
			divider.className = 'ibc__divider';
			const groupStat = this.#buildStat(LABELS.group, 'group');

			body.append(directStat.node, divider, groupStat.node);

			const footer = document.createElement('div');
			footer.className = 'ibc__footer';

			const message = document.createElement('div');
			message.className = 'ibc__message';

			root.append(body, footer, message);

			this.dom.textContent = '';
			this.dom.appendChild(root);
			// Lets .ibc__value scale with the widget, not the browser window.
			this.dom.style.containerType = 'inline-size';

			this.#refs = {
				root,
				direct: directStat.value,
				group: groupStat.value,
				footer,
				message
			};

			this.#render();
		}

		#buildStat(labelText, mode) {
			const node = document.createElement('button');
			node.type = 'button';
			node.className = 'ibc__stat';
			node.title = LABELS.openHint(labelText);

			const value = document.createElement('span');
			value.className = 'ibc__value';
			value.textContent = '–';

			const label = document.createElement('span');
			label.className = 'ibc__label';
			label.textContent = labelText;

			node.append(value, label);
			node.addEventListener('click', () => this.#openInBasket(mode));

			return { node, value };
		}

		/**
		 * Opens the InBasket Task search tab with the button's Favorite search:
		 *   1. the favorite chosen in the widget settings, if this user can
		 *      see it (favorites belong to one user, so one chosen by the
		 *      dashboard's author is usually invisible to everyone else);
		 *   2. otherwise the user's own "Assigned to Me" / "Assigned to Group"
		 *      favorite, created on the first click.
		 * If the favorite cannot be created, the unfiltered InBasket opens.
		 *
		 * arasTabs.openSearch(itemTypeId, favoriteSearchId) applies the saved
		 * search itself, so there is no criteria injection and no timing race to
		 * manage.
		 *
		 * mode: 'direct' | 'group' | null (null opens the unfiltered InBasket).
		 */
		async #openInBasket(mode) {
			const itemTypeId = aras.getItemTypeId(INBASKET_ITEMTYPE);
			if (!itemTypeId) {
				// eslint-disable-next-line no-console
				console.warn(`[InBasketCounts] ItemType "${INBASKET_ITEMTYPE}" not found`);
				return;
			}

			const mainWindow = aras.getMainWindow();
			if (!mainWindow || !mainWindow.arasTabs) {
				// eslint-disable-next-line no-console
				console.warn('[InBasketCounts] main window tabs unavailable');
				return;
			}

			let favoriteId;
			if (mode) {
				favoriteId = this.#getConfiguredFavoriteId(mode);
				if (!favoriteId) {
					try {
						favoriteId = await getOrCreateFavorite(mode);
					} catch (error) {
						// eslint-disable-next-line no-console
						console.warn(
							`[InBasketCounts] could not create the "${GENERATED_FAVORITES[mode].label}" Favorite search; opening the unfiltered InBasket:`,
							describeSoapError(error)
						);
					}
				}
			}

			mainWindow.arasTabs.openSearch(itemTypeId, favoriteId);
		}

		/** The favorite chosen in the settings, if the current user has it. */
		#getConfiguredFavoriteId(mode) {
			const configured = this.state ? this.state[FAVORITE_PROPS[mode]] : '';
			if (!GUID.test(String(configured || ''))) {
				return undefined;
			}
			if (getFavorites()[configured]) {
				return configured;
			}

			// eslint-disable-next-line no-console
			console.info(
				`[InBasketCounts] the Favorite search set for "${mode}" is unavailable to this user; using their own`
			);
			return undefined;
		}

		#render() {
			if (!this.#refs) {
				return;
			}

			const {
				status = 'loading',
				direct = 0,
				group = 0,
				total = 0,
				partial = false,
				error = null
			} = this.state || {};
			const { root, footer, message } = this.#refs;

			root.className = `ibc ibc_state-${status}`;

			if (status === 'ready') {
				this.#refs.direct.textContent = String(direct);
				this.#refs.group.textContent = String(group);
				footer.textContent = LABELS.total(total);
			} else if (status === 'error') {
				this.#refs.direct.textContent = '–';
				this.#refs.group.textContent = '–';
				footer.textContent = '';
			} else {
				footer.textContent = LABELS.loading;
			}

			if (status === 'error') {
				message.className = 'ibc__message ibc__message_error';
				message.textContent = error ? `${LABELS.error}: ${error}` : LABELS.error;
			} else if (status === 'ready' && partial) {
				message.className = 'ibc__message';
				message.textContent = LABELS.partial;
			} else {
				message.className = 'ibc__message';
				message.textContent = '';
			}
		}
	};
}

/**
 * Settings-dialog customizer: turns favorite_direct_id / favorite_group_id into
 * Favorite-search pickers.
 *
 * Both props are declared as prop_type "text" on the Dashboard Widget Template,
 * and this replaces their metadata with type "filterList" plus the live
 * favorites; the picked id is stored as plain text. Do NOT declare them as
 * prop_type "list" unless prop_source also points at a real List, or the
 * settings dialog fails to open.
 *
 * Register with: addFormCustomizer({ InBasketCounts: inBasketCountsFormCustomizer })
 */
export const inBasketCountsFormCustomizer = async (
	widget,
	widgetPropsMetadata,
	metadata,
	data
) => {
	const options = getInBasketSearchFavorites();
	const customizedMetadata = {};
	const customizedData = {};
	let changed = false;

	Object.values(FAVORITE_PROPS).forEach((propName) => {
		const propMetadata = metadata[propName];
		if (!propMetadata) {
			return; // prop not on this template - nothing to customize
		}

		changed = true;
		const propDefinition = widgetPropsMetadata[propName] || {};
		const list =
			propDefinition.required === '1'
				? options
				: [{ label: '', value: '' }].concat(options);

		customizedMetadata[propName] = {
			...propMetadata,
			type: 'filterList',
			list
		};

		// Drop a stale id if that Favorite has since been deleted or renamed away,
		// otherwise the picker shows blank while widget_data still holds the id.
		const current = data[propName] ?? widget.widget_data[propName] ?? '';
		const stillExists = options.some((option) => option.value === current);
		customizedData[propName] = stillExists ? current : '';
	});

	return {
		metadata: changed ? customizedMetadata : null,
		data: changed ? customizedData : null
	};
};
