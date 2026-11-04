# FRG_DashboardWidgets 1.0.0

An Aras Update package that gives Aras Innovator users a friendlier home
page: five custom dashboard widgets, and a ready-made **Home** dashboard that
shows four of them together.

| Widget | Type key | Module |
|---|---|---|
| In-Basket Tasks | `InBasketCounts` | `FRG_inBasketCountsWidget.js` |
| Pinned ItemTypes | `PinnedItemTypes` | `FRG_pinnedItemTypesWidget.js` |
| Recently Viewed | `RecentlyViewed` | `FRG_recentlyViewedWidget.js` (+ `FRG_recentItems.js`) |
| Favorites | `Favorites` | `FRG_favoritesWidget.js` |
| Quick Find | `QuickFind` | `FRG_quickFindWidget.js` (+ `FRG_quickFindSearch.js`) |

`FRG_widgetContextMenu.js` adds the right-click menus to Pinned ItemTypes,
Favorites and Recently Viewed. `FRG_itemVersions.js` makes Favorites and
Recently Viewed open the latest generation of a versionable item, and lets
Recently Viewed list each item once across its generations. `FRG_itemAccess.js`
hides the entries in both that the user can no longer read (Mandatory Access
Control, permissions, deletion), with one query per ItemType.

Installs into Innovator 14.0.25 or later (tested on 14.0.25 and 14.35.0).
Requires Aras Update 1.18 or later.

See `README.md` in the ArasHomeDashboard repository for the full guide.

## Package layout

```
1.0.0/
  package.config              <- installer definition
  compatibility.config        <- lowest Innovator release the package accepts
  FRG_README.md               <- this file
  Resources/
    resources.config.xml
    resource.neutral          <- module labels shown in the installer
  Innovator/Client/customer/dashboard/
    FRG_registerWidgets.js    <- entry point: registers all five widgets
    FRG_inBasketCountsWidget.js
    FRG_pinnedItemTypesWidget.js
    FRG_recentItems.js
    FRG_recentlyViewedWidget.js
    FRG_favoritesWidget.js
    FRG_quickFindWidget.js
    FRG_quickFindSearch.js    <- Quick Find search logic, used by the widget
    FRG_widgetContextMenu.js  <- right-click menus shared by three widgets
    FRG_itemVersions.js       <- latest generation / one entry per item, for two widgets
    FRG_itemAccess.js         <- hides entries the user can no longer read, for two widgets
  Scripts/
    FRG_injectDashboardView.ps1   <- adds the registration call to the dashboard view
    FRG_restartClientApp.ps1      <- restarts the Client app so the new cache token applies
  Imports/
    imports.mf                    <- package PLMForge.DashboardWidgets
    FRG_DashboardWidgets/
      Dashboard Widget Template/  <- the five templates (exported AML)
      cui_Dashboard/Home.xml      <- the Home dashboard (exported, then cleaned)
      Fixes/                      <- edits to items owned by Aras packages
```

Files in `Fixes/` are named `[SourcePackageName].[ItemType].[KeyedName].xml`.
Each one edits an existing Aras item (`action="edit"`) and adds this
package's rows to it.

## Modules

**`IS` - Client Code Tree** (needs `Innovator.Dir`)

1. Increments `filesRevision` in `Client\InnovatorClient.config`, so browsers
   load the new files instead of cached copies.
2. Copies `Innovator/Client/customer/dashboard/` into the code tree.
3. Adds a small, clearly marked block to `dashboardEditorView.cshtml` (see
   below).
4. Restarts the Client web application (not its application pool), because
   it reads `filesRevision` only at startup.

**`DB` - Database** (needs `Innovator.URL`, `Innovator.DB`,
`Innovator.Username`, `Innovator.Password`)

Imports the AML under `Imports/`:

- the Dashboard Widget Templates *InBasket Counts*, *Pinned ItemTypes*,
  *Recently Viewed*, *Favorites* and *Quick Find*;
- the *Home* dashboard (cui_Dashboard), laid out to fit a 1080p screen;
- the values `InBasketCounts`, `PinnedItemTypes`, `RecentlyViewed`,
  `Favorites` and `QuickFind` on the List *Dashboard Widget Types*;
- the Text property `cust_recent_items` on the ItemType *Core_GlobalLayout*.

Then, only where the release has dashboard sharing (the
`Dashboard_AccessSharing` ItemType), it shares Home with World as a Viewer,
unless that share already exists.

Re-running the module updates these items in place, including Home's layout.

## Installing

Run Aras Update as administrator.

- **GUI** - *Local Packages*, then *Add package reference*, and select this
  `1.0.0` folder. Select both modules.
- **Command line**

```
ArasUpdateCmd.exe install FRG_DashboardWidgets -version:1.0.0 ^
  -path:"<path to this folder>" ^
  -modules:IS|DB ^
  -D:Innovator.Dir="<Innovator install folder>\Innovator" ^
  -D:Innovator.URL="http://<server>/<Innovator web alias>" ^
  -D:Innovator.DB="<database>" ^
  -D:Innovator.Username="admin" ^
  -D:Innovator.Password="<password>" ^
  -logLevel:2
```

`Innovator.Dir` is the folder that *contains* `Client` and `Server`. The
installer checks this before changing anything.

> Separate modules with a pipe: `-modules:IS|DB`. A comma is treated as a
> single unknown module name, and the run reports success without installing
> anything.

## The edit to dashboardEditorView.cshtml

This is the only Aras file the package modifies. The script makes three
edits. Each is skipped if already present, so re-running the install is safe.
If anything unexpected is found, the install stops before writing.

- `// BEGIN FRG no-cache headers` ... `// END` - stops the browser caching
  the page, so a new install takes effect on the next reload.
- The existing `import { ... } from '.../dashboard.es.js'` line gains
  `addWidgetLayout`, `addFormCustomizer` and `WidgetLayout` if they are not
  already listed.
- `// BEGIN FRG dashboard widgets` ... `// END FRG dashboard widgets` - loads
  `FRG_registerWidgets.js` and registers the widgets.

The script will not run if it finds widget code already pasted into the view
by hand (for example `loadInBasketCountsLayout`), because the widgets would be
registered twice. Restore the stock file and install again.

**To revert:** delete the text between each `BEGIN` / `END` pair, and remove
the names that were added to the import line. Optionally delete the `FRG_*.js`
files from `Client\customer\dashboard\`. Aras Update has no uninstall action.

**After an Innovator upgrade** that replaces this view, run the package again.

## Updating the AML

The templates and the Home dashboard belong to the PackageDefinition
`PLMForge.DashboardWidgets`. After changing them in Innovator, export that
package with the Aras Package Import/Export Utilities and replace the files in
`Imports/FRG_DashboardWidgets/Dashboard Widget Template/` and
`Imports/FRG_DashboardWidgets/cui_Dashboard/`. Clean the exported `Home.xml`
as described in the main README ("How Home.xml was made") before committing it.

Items owned by Aras packages can't be added to `PLMForge.DashboardWidgets`.
Changes to those go in `Fixes/` as hand-written `edit` AML.
