// Folder-selection ("Change Dir") dialog, extracted from renderer.ts.
//
// This module builds the promise-based directory picker used by the
// 'Change Dir' button. It is fully independent of the workspace and returns
// the selected path (or null when cancelled). Styling comes from
// workingDir.css; the window.axle bridge typings are declared globally in
// renderer.ts.

/**
 * A remote server entry discovered from the 'ssh' / 'scp' skills in
 * .skill.config. Mirrors the RemoteServer interface in src/core/executor.ts.
 */
export interface RemoteServer {
  name: string;
  skill: string;
  host?: string;
  port?: string;
  userName?: string;
  authType?: string;
}

/**
 * Standalone, promise-based directory picker dialog. It is fully independent
 * of the workspace and returns the selected path (or null when cancelled).
 */
export function openFolderChooser(modelName: string): Promise<string | null> {
  // Remove any existing overlay/dialog.
  const existingOverlay = document.querySelector('.dir-modal-overlay');
  if (existingOverlay) existingOverlay.remove();
  const existingDialog = document.querySelector('.dir-dialog');
  if (existingDialog) existingDialog.remove();

  // Full-screen backdrop that turns the dialog into a true modal. All visual
  // styling (position, sizing, colors, layout) is provided by the matching
  // classes in workingDir.css; no inline styles are set here so the stylesheet
  // has full control over the dialog's appearance.
  const overlay = document.createElement('div');
  overlay.className = 'dir-modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dir-dialog';

  const header = document.createElement('div');
  header.className = 'dir-dialog-header';

  const title = document.createElement('span');
  title.textContent = 'Choose a folder';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.className = 'dir-dialog-close';

  header.appendChild(title);
  header.appendChild(closeBtn);

  // ---- Tab bar: 'Local' (existing browser) | 'Remote' (server picker) ----
  const tabBarEl = document.createElement('div');
  tabBarEl.className = 'dir-dialog-tabs';

  const localTab = document.createElement('button');
  localTab.type = 'button';
  localTab.className = 'dir-dialog-tab active';
  localTab.textContent = 'Local';

  const remoteTab = document.createElement('button');
  remoteTab.type = 'button';
  remoteTab.className = 'dir-dialog-tab';
  remoteTab.textContent = 'Remote';

  tabBarEl.appendChild(localTab);
  tabBarEl.appendChild(remoteTab);
  header.appendChild(tabBarEl);

  const dialogBody = document.createElement('div');
  dialogBody.className = 'dir-dialog-body';

  // ---- 'Local' pane: the original directory browser ----
  const localPane = document.createElement('div');
  localPane.className = 'dir-dialog-pane dir-dialog-pane-local';

  const pathLabel = document.createElement('div');
  pathLabel.className = 'dir-dialog-path';
  localPane.appendChild(pathLabel);

  const list = document.createElement('div');
  list.className = 'dir-dialog-list';
  localPane.appendChild(list);

  dialogBody.appendChild(localPane);

  // ---- 'Remote' pane: pick a configured remote server (ssh/scp skills) ----
  const remotePane = document.createElement('div');
  remotePane.className = 'dir-dialog-pane dir-dialog-pane-remote hidden';

  const remoteLabel = document.createElement('div');
  remoteLabel.className = 'dir-dialog-remote-label';
  remoteLabel.textContent = 'Select a remote server:';
  remotePane.appendChild(remoteLabel);

  const remoteSelect = document.createElement('select');
  remoteSelect.className = 'dir-dialog-remote-select';
  remotePane.appendChild(remoteSelect);

  const remoteHint = document.createElement('div');
  remoteHint.className = 'dir-dialog-remote-hint';
  remoteHint.textContent = 'Servers are loaded from the \'ssh\' and \'scp\' skills in .skill.config.';
  remotePane.appendChild(remoteHint);

  // Remote path label + directory list, mirroring the local pane. The list is
  // populated over SSH via window.axle.listRemoteDir once a server is chosen.
  const remotePathLabel = document.createElement('div');
  remotePathLabel.className = 'dir-dialog-path';
  remotePane.appendChild(remotePathLabel);

  const remoteList = document.createElement('div');
  remoteList.className = 'dir-dialog-list';
  remotePane.appendChild(remoteList);

  dialogBody.appendChild(remotePane);

  const footer = document.createElement('div');
  footer.className = 'dir-dialog-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const selectBtn = document.createElement('button');
  selectBtn.textContent = 'Select this folder';
  selectBtn.className = 'primary';

  footer.appendChild(cancelBtn);
  footer.appendChild(selectBtn);

  dialog.appendChild(header);
  dialog.appendChild(dialogBody);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let currentPath = '';

  // ---- Tab state + switching ----
  // activeTab tracks which tab ('local' | 'remote') drives the footer action.
  let activeTab: 'local' | 'remote' = 'local';
  let remoteServersLoaded = false;

  function showTab(tab: 'local' | 'remote'): void {
    activeTab = tab;
    const isLocal = tab === 'local';

    // Visibility is toggled via the 'hidden' class so workingDir.css controls
    // the pane layout; no inline display values are set here.
    localPane.classList.toggle('hidden', !isLocal);
    remotePane.classList.toggle('hidden', isLocal);

    localTab.classList.toggle('active', isLocal);
    remoteTab.classList.toggle('active', !isLocal);

    // Lazily load the remote servers the first time the Remote tab is opened.
    if (!isLocal && !remoteServersLoaded) {
      loadRemoteServers();
    }
  }

  async function loadRemoteServers(): Promise<void> {
    remoteSelect.innerHTML = '';

    let servers: RemoteServer[] = [];
    try {
      servers = await window.axle.getRemoteServers();
      remoteServersLoaded = true;
    } catch (e) {
      console.error('Failed to load remote servers:', e);
      remoteServersLoaded = false;
      servers = [];
    }

    if (servers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no remote servers configured)';
      remoteSelect.appendChild(opt);
      remoteSelect.disabled = true;
      return;
    }

    remoteSelect.disabled = false;
    // Empty placeholder so no server is preselected by default; the real
    // SSH servers become visible only when the user opens the dropdown (down button).
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a server...';
    placeholder.disabled = true;
    remoteSelect.appendChild(placeholder);
    for (const server of servers) {
      const opt = document.createElement('option');
      opt.value = server.name;
      const detail = [server.skill, server.host].filter(Boolean).join(' \u00b7 ');
      opt.textContent = detail ? `${server.name} (${detail})` : server.name;
      remoteSelect.appendChild(opt);
    }
    // Enforce the empty default explicitly so nothing is preselected.
    remoteSelect.value = '';
  }

  // ---- Remote directory browsing (mirrors the local pane's loadDir) ----
  // Remote hosts are Linux-like, so '/' is always used as the separator.
  let remoteCurrentPath = '';

  function remoteJoinPath(dir: string, name: string): string {
    if (!dir) return '/' + name;
    return dir.endsWith('/') ? dir + name : dir + '/' + name;
  }

  function remoteParentPath(dir: string): string {
    if (!dir) return dir;
    const idx = dir.lastIndexOf('/');
    // Parent of a top-level directory (e.g. '/home') is the root '/'.
    // Without this the up button is a silent no-op at the parent of home.
    if (idx === 0) return '/';
    // No separator at all means there is no parent to go to.
    if (idx < 0) return dir;
    return dir.substring(0, idx);
  }

  // Browse a directory (relative to the login/home dir when `dir` is empty) on
  // the currently-selected remote server, exactly like loadDir does locally.
  async function loadRemoteDir(dir: string): Promise<void> {
    const server = remoteSelect.value;
    if (!server) return;
    remoteCurrentPath = dir;
    remoteList.innerHTML = '';

    const result = await window.axle.listRemoteDir(server, dir || undefined);

    if (result.error) {
      remotePathLabel.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'dir-dialog-remote-error';
      errEl.textContent = result.error;
      remoteList.appendChild(errEl);
      return;
    }

    remoteCurrentPath = result.path || dir;
    remotePathLabel.textContent = remoteCurrentPath;

    // 'Up' navigation, mirroring the local pane.
    const up = document.createElement('button');
    up.textContent = '.. (up)';
    up.className = 'dir-up';
    up.addEventListener('click', () => {
      const p = remoteParentPath(remoteCurrentPath);
      if (p !== remoteCurrentPath) loadRemoteDir(p);
    });
    remoteList.appendChild(up);

    for (const d of result.dirs) {
      const item = document.createElement('button');
      item.textContent = d;
      item.className = 'dir-item';
      item.addEventListener('click', () => loadRemoteDir(remoteJoinPath(remoteCurrentPath, d)));
      remoteList.appendChild(item);
    }
  }

  // When a server is picked from the drop-down, start browsing at its home dir.
  remoteSelect.addEventListener('change', () => {
    const server = remoteSelect.value;
    if (!server) return;
    remoteCurrentPath = '';
    loadRemoteDir('');
  });

  localTab.addEventListener('click', () => showTab('local'));
  remoteTab.addEventListener('click', () => showTab('remote'));

  function joinPath(dir: string, name: string): string {
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
  }

  function parentPath(dir: string): string {
    const sep = dir.includes('\\') ? '\\' : '/';
    const idx = dir.lastIndexOf(sep);
    if (idx <= 0) return dir;
    return dir.substring(0, idx);
  }

  async function loadDir(dir: string): Promise<void> {
    currentPath = dir;
    pathLabel.textContent = dir;
    const dirs = await window.axle.listDir(dir);
    list.innerHTML = '';

    // 'Up' navigation
    const up = document.createElement('button');
    up.textContent = '.. (up)';
    up.className = 'dir-up';
    up.addEventListener('click', () => {
      const p = parentPath(currentPath);
      if (p !== currentPath) loadDir(p);
    });
    list.appendChild(up);

    for (const d of dirs) {
      const item = document.createElement('button');
      item.textContent = d;
      item.className = 'dir-item';
      item.addEventListener('click', () => loadDir(joinPath(currentPath, d)));
      list.appendChild(item);
    }
  }

  // Return a promise that resolves with the selected folder or null.
  return new Promise((resolve) => {
    // Tear down the modal: remove the overlay and detach the Escape listener.
    const cleanup = (): void => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    };

    // Escape key closes the modal (treated as a cancel).
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };
    document.addEventListener('keydown', onKeydown);

    closeBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    selectBtn.addEventListener('click', () => {
      if (activeTab === 'remote') {
        const server = remoteSelect.value;
        if (!server) return;
        // Signal a remote-server selection using a 'remote://<name>' marker so
        // the caller can distinguish it from a local filesystem path.
        cleanup();
        resolve('remote://' + server);
        return;
      }
      if (!currentPath) return;
      const chosen = currentPath;
      cleanup();
      resolve(chosen);
    });

    // Clicking the backdrop (outside the dialog box) cancels the modal.
    overlay.addEventListener('click', (ev: MouseEvent) => {
      if (ev.target === overlay) {
        cleanup();
        resolve(null);
      }
    });

    // Start browsing from the default working dir.
    window.axle.getWorkingDir(modelName).then(loadDir);
  });
}
