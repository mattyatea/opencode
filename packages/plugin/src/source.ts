import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { Hash } from "@opencode/util/hash"

// Keep source fingerprints and import attempts together. Filesystem events
// should reload changed local graphs, not repeat unchanged evaluations.
// Process-wide like a package's import: each Location owns a loader, and a copy of the module per Location would
// duplicate the plugin's module state (its singletons, child processes, in-flight work) once per directory.
const sources = new Map<string, Source>()

export function createPluginSources(watch: (file: string) => Promise<void>) {
  const cleanups: Array<() => void> = []
  const watching = new Set<Promise<void>>()
  const observe = (file: string) => {
    const pending = watch(file).finally(() => watching.delete(pending))
    watching.add(pending)
    // Watch setup can be interrupted while module evaluation is still pending.
    void pending.catch(() => {})
  }
  return {
    read: async (entrypoint: string) => {
      await Promise.all(watching)
      const previous = sources.get(entrypoint)
      if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory)))
        // The graph is only complete once evaluated; every Location watches it to reload on its own.
        return previous.loaded.finally(() => {
          for (const file of previous.files.keys()) observe(file)
          return Promise.all(watching)
        })

      const files: Source["files"] = new Map()
      const track = (file: string, directory = false) => {
        if (files.has(file)) return
        files.set(file, { digest: digest(file, directory), directory })
        observe(file)
      }
      track(fileURLToPath(entrypoint))
      // Cache the attempt before evaluating it: unchanged failing modules must
      // not repeat import-time effects on every filesystem notification, and
      // Locations booting together must share one evaluation.
      const loaded = import("#plugin-source")
        .then(({ prepareSource }) => prepareSource(entrypoint, track))
        .then((prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void }) => {
          if (prepared.dispose) cleanups.push(prepared.dispose)
          return prepared.load().then((module) => ({ version: prepared.version, module }))
        })
      sources.set(entrypoint, { loaded, files })
      return loaded.finally(() => Promise.all(watching))
    },
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

type Source = {
  loaded: Promise<{ version: string; module: unknown }>
  files: Map<string, { digest: string; directory: boolean }>
}

function digest(file: string, directory: boolean) {
  try {
    return Hash.sha256(directory ? JSON.stringify(readdirSync(file).sort()) : readFileSync(file))
  } catch {
    return "missing"
  }
}

export function localSource(spec: string, directory: string) {
  if (spec.startsWith("file://")) return new URL(spec)
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
    return pathToFileURL(path.resolve(directory, spec))
  return undefined
}
