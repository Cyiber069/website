# Rojo Project Layout

> When code is edited outside Studio, mirror the Roblox service layout in a source folder with three roots, server, client and shared, mapped by one Rojo project file.

## Why use a file-based project

Rojo syncs files on disk into Studio's instance tree. That allows version control, code review, external editors, and agents that work with files. Why adopt it early: moving an existing Studio-only project to files later means exporting and reorganising every script.

## Folder structure

```text
project/
  default.project.json
  src/
    server/            -> ServerScriptService.Server
      init.server.luau
      DataService.luau
      EconomyService.luau
    client/            -> StarterPlayerScripts.Client
      init.client.luau
      HudController.luau
    shared/            -> ReplicatedStorage.Shared
      Config/
        UpgradeConfig.luau
      Types.luau
      Remotes.luau
```

File naming decides the instance type: a name ending in `.server.luau` becomes a Script, `.client.luau` becomes a LocalScript, and any other `.luau` file becomes a ModuleScript. A folder containing an `init` file becomes that script with the folder's other files as children. Why this matters: a misnamed file silently becomes a ModuleScript that never runs.

## Project file

```json
{
  "name": "my-game",
  "tree": {
    "$className": "DataModel",
    "ServerScriptService": {
      "Server": { "$path": "src/server" }
    },
    "ReplicatedStorage": {
      "Shared": { "$path": "src/shared" }
    },
    "StarterPlayer": {
      "StarterPlayerScripts": {
        "Client": { "$path": "src/client" }
      }
    }
  }
}
```

## Rules

- **Code lives in files; the world lives in the place.** Map only script containers in the project file and leave Workspace, Lighting and interface layout to be built in Studio, unless the team has chosen a fully managed workflow. Why: syncing over hand-built map content can overwrite it.
- **Files are the source of truth for code.** Do not edit synced scripts inside Studio; changes there are lost or cause conflicts.
- **Three roots mirror the trust boundary.** Anything under `src/server` is never sent to clients; anything under `src/shared` or `src/client` is. Why: the folder a file sits in answers the security question; see [[Server-Authoritative Remotes]].
- **Keep the same module conventions** as [[Code Layout In Roblox Services]]: one entry script per side, services and controllers as modules.
- **Commit the project file and any tool version manifest.** Why: every contributor and agent then syncs identically.
- **Do not commit secrets.** API keys for external tools stay out of the repository.

## Working routine for agents

1. Edit files under `src`.
2. Sync to Studio with the Rojo plugin connected to a running `rojo serve`, or build a place file.
3. Test using [[Studio Test Modes]].
4. Report the files changed, by path.

If Rojo is not part of the project, do not introduce it without being asked; apply the same structure directly in Studio instead.

## Check before you hand off

- Every new file sits under the correct root for its trust level.
- Script files use the correct `.server.luau` or `.client.luau` suffix; modules use plain `.luau`.
- The project file maps only intended containers.
- No synced script was edited in Studio.
- The hand-off lists changed file paths and confirms the project synced and ran.
