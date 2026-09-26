/**
 * Whether this process may create symbolic links. The symlink-confinement
 * fixtures (#213) need real symlinks; Windows only allows them to elevated
 * processes or with Developer Mode, so suites probe once and skip honestly
 * (`it.skipIf`) instead of failing with EPERM. POSIX always probes true.
 * @module dsh-mimir/tests/helpers/symlink-capability
 */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let probed: boolean | undefined

/** Probe link creation once in the OS temp dir and cache the verdict. */
export function canCreateSymlink(): boolean {
  if (probed !== undefined) return probed
  const dir = mkdtempSync(join(tmpdir(), 'mimir-symlink-probe-'))
  try {
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    probed = true
  } catch {
    probed = false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return probed
}
