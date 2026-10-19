// BACKGROUND SCRIPT — loaded once by the browser, no DOM.
// For now it just opens the sidebar when the toolbar button is clicked.
// Later, the agent loop and any API keys would live here.

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.open();
});
