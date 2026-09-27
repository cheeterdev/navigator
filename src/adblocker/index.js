import { ElectronBlocker } from '@ghostery/adblocker-electron';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export class AdblockerManager {
  constructor() {
    /** @type {ElectronBlocker|null} */
    this.blocker = null;
    this.stats = { blocked: 0 };
    this.onStatsChange = null;
  }

  async init() {
    const cachePath = path.join(app.getPath('userData'), 'adblocker.bin');
    const options = {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    };

    this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, options);

    const originalMatch = this.blocker.match.bind(this.blocker);
    this.blocker.match = (request) => {
      const result = originalMatch(request);
      if ((result.match && result.match.cancel) || result.redirect) {
        this.stats.blocked += 1;
        if (typeof this.onStatsChange === 'function') {
          try { this.onStatsChange({ ...this.stats }); } catch (e) {}
        }
      }
      return result;
    };
  }

  enableSession(sess) {
    if (!this.blocker) return;
    try {
      this.blocker.enableBlockingInSession(sess);
    } catch (e) {
    }
  }

  disableSession(sess) {
    if (!this.blocker) return;
    if (this.blocker.isBlockingEnabled(sess)) {
      this.blocker.disableBlockingInSession(sess);
    }
  }

  getStats() {
    return { ...this.stats };
  }
}
