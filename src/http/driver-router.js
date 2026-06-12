'use strict';

/**
 * DriverRouter — uniform HTTP-to-driver dispatcher for v0.4.0 driver commands.
 *
 * Each /api/<driver> endpoint takes `{action, ...rest}` and dispatches to the
 * named method on the corresponding driver, unpacking named params in a
 * stable order. This keeps HTTP surface area small (9 endpoints, 100+ actions)
 * and lets drivers keep their preferred positional signatures.
 *
 * Usage:
 *   const router = new DriverRouter({ editor, file, ... });
 *   await router.invoke('editor', { action: 'writeActive', value: 'hello' });
 */

const { TraeCNAutomationError } = require('../cdp/errors');

/**
 * actionSpec maps action name → list of param keys in positional order.
 *   { save: [], writeActive: ['value'], find: ['query', 'include', 'exclude'] }
 * Empty array means no args.
 */
const EDITOR_ACTIONS = {
  // accept/reject AI edits (DOM, no palette)
  acceptAll: [],
  rejectAll: [],
  acceptNext: [],
  rejectNext: [],
  readApplyState: [],
  // file ops via palette
  save: [], saveAll: [], saveAs: [], revertFile: [], revertAll: [],
  closeActive: [], closeAll: [], newFile: [], revealInExplorer: [],
  copyPathOfActive: [], reloadWindow: [], toggleSidebar: [], togglePanel: [],
  splitEditor: [], showCommands: [],
  // editor text ops via palette
  undo: [], redo: [], formatDocument: [], formatSelection: [], commentLine: [],
  copyLinesDown: [], copyLinesUp: [], moveLinesDown: [], moveLinesUp: [],
  insertCursorAbove: [], insertCursorBelow: [], insertCursorAtEachMatchSelection: [],
  expandLineSelection: [], shrinkSelection: [], addSelectionToNextFindMatch: [],
  addSelectionToPreviousFindMatch: [], selectAll: [], triggerSuggest: [],
  showHover: [], gotoLine: [],
  // symbol / refactor via palette
  revealDefinition: [], peekDefinition: [], showReferences: [], renameSymbol: [],
  findAllReferences: [], implementInterface: [], quickFix: [], refactor: [],
  // folding via palette
  fold: [], unfold: [], foldAll: [], unfoldAll: [],
  foldRecursively: [], unfoldRecursively: [],
  // monaco direct read/write
  readActive: [],
  writeActive: ['value'],
  listActive: []
};

const FILE_ACTIONS = {
  closeActive: [], closeAll: [], closeOthers: [], newFile: [], revertFile: [],
  revealInExplorer: [], copyPath: [], save: [], saveAll: [], saveAs: [],
  openFileByPath: ['filePath'],
  listOpenEditors: [],
  listExplorerVisible: [],
  readDisk: ['filePath'],
  writeDisk: ['filePath', 'content'],
  deleteDisk: ['filePath'],
  mkdirDisk: ['dirPath'],
  listTreeDisk: ['rootPath', 'opts'],
  renameDisk: ['oldPath', 'newPath']
};

const TERMINAL_ACTIONS = {
  toggleTerminal: [], newTerminal: [], killTerminal: [], clearTerminal: [],
  splitTerminal: [], focusTerminal: [],
  snapshot: [],
  tail: ['lines'],
  send: ['text'],
  sendLine: ['text'],
  sendKey: ['key', 'code', 'wvk', 'modifiers'],
  sendCtrlC: [], sendCtrlD: [], sendCtrlL: [], sendCtrlZ: [],
  selectTab: ['title']
};

const GIT_ACTIONS = {
  openSCM: [], focusSCM: [], refreshSCM: [],
  stageAll: [], unstageAll: [], commit: [], commitAmend: [], commitSignedOff: [],
  push: [], pull: [], sync: [], fetch: [], clone: [], init: [], checkout: [],
  branch: [], merge: [], rebase: [], stash: [], stashPop: [], stashApply: [],
  showOutput: [], showLog: [], diff: [],
  commitWithMessage: ['message'],
  readStatus: [],
  readCurrentBranch: [],
  execGit: ['args', 'opts']
};

const SEARCH_ACTIONS = {
  openSearch: [], findInFiles: [], closeSearch: [],
  toggleCaseSensitive: [], toggleWholeWord: [], toggleRegex: [],
  collapseAll: [],
  find: ['query', 'opts'],
  readResults: ['maxResults']
};

const DIAGNOSTICS_ACTIONS = {
  openProblems: [], focusProblems: [], nextProblem: [], prevProblem: [],
  nextInFiles: [], showErrors: [],
  readAll: ['max'],
  readModelMarkers: ['max'],
  count: [],
  hover: ['line', 'column']
};

const SNAPSHOT_ACTIONS = {
  dom: ['selector'],
  text: ['selector'],
  layout: ['opts'],
  pageHash: [],
  screenshot: ['targetPath'],
  screenshotElement: ['selector', 'targetPath']
};

const EXTENSION_ACTIONS = {
  openExtensions: [], focusExtensions: [], openMarketplace: [],
  install: [], uninstall: [], enable: [], enableAll: [], enableAllWorkspace: [],
  disable: [], disableAll: [], disableAllWorkspace: [],
  showInstalled: [], showEnabled: [], showDisabled: [], showOutdated: [],
  updateAll: [],
  searchMarketplace: ['query', 'opts'],
  readVisible: ['max'],
  listViaCLI: ['opts'],
  installViaCLI: ['extensionId', 'version'],
  uninstallViaCLI: ['extensionId']
};

const COMMAND_ACTIONS = {
  open: [],
  close: [],
  run: ['commandId', 'opts'],
  runSequence: ['commandIds']
};

const DRIVER_SPEC = {
  editor: EDITOR_ACTIONS,
  file: FILE_ACTIONS,
  terminal: TERMINAL_ACTIONS,
  git: GIT_ACTIONS,
  search: SEARCH_ACTIONS,
  diagnostics: DIAGNOSTICS_ACTIONS,
  snapshot: SNAPSHOT_ACTIONS,
  extension: EXTENSION_ACTIONS,
  command: COMMAND_ACTIONS
};

class DriverRouter {
  constructor(domDriver) {
    if (!domDriver) throw new Error('DriverRouter requires a DomDriver instance');
    this.domDriver = domDriver;
  }

  _getDriver(name) {
    switch (name) {
      case 'editor': return this.domDriver.editor;
      case 'file': return this.domDriver.file;
      case 'terminal': return this.domDriver.terminal;
      case 'git': return this.domDriver.git;
      case 'search': return this.domDriver.search;
      case 'diagnostics': return this.domDriver.diagnostics;
      case 'snapshot': return this.domDriver.snapshot;
      case 'extension': return this.domDriver.extension;
      case 'command': return this.domDriver.palette;
      default: return null;
    }
  }

  /**
   * Invoke a driver action.
   * @param {string} name One of the 9 driver names.
   * @param {object} params `{action, ...positionalArgs}`
   * @returns {Promise<*>} Result from the driver method.
   */
  async invoke(name, params) {
    const spec = DRIVER_SPEC[name];
    if (!spec) {
      throw new TraeCNAutomationError(`Unknown driver: ${name}`, 'UNKNOWN_DRIVER', { name });
    }
    const driver = this._getDriver(name);
    if (!driver) {
      throw new TraeCNAutomationError(`Driver not initialized: ${name}`, 'DRIVER_NOT_READY', { name });
    }
    const { action, ...rest } = params || {};
    if (!action) {
      throw new TraeCNAutomationError('action is required', 'MISSING_ACTION', { driver: name });
    }
    const paramKeys = spec[action];
    if (!paramKeys) {
      throw new TraeCNAutomationError(`Unknown action for ${name}: ${action}`, 'UNKNOWN_ACTION', { driver: name, action, available: Object.keys(spec) });
    }
    const fn = driver[action];
    if (typeof fn !== 'function') {
      throw new TraeCNAutomationError(`Driver ${name} has no method: ${action}`, 'METHOD_MISSING', { driver: name, action });
    }
    const args = paramKeys.map(k => k in rest ? rest[k] : undefined);
    return await fn.call(driver, ...args);
  }

  listActions(name) {
    const spec = DRIVER_SPEC[name];
    if (!spec) return [];
    return Object.entries(spec).map(([action, params]) => ({ action, params }));
  }
}

module.exports = { DriverRouter, DRIVER_SPEC };
