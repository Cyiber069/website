# DataStore Save Patterns

> Load once with a session lock, keep data in server memory, write with UpdateAsync, retry failures with backoff, and flush everything in BindToClose.

## Rules and reasons

- **One table per player under one key.** Why: one read and one write per session event, and the whole profile stays consistent.
- **Load on join, keep in memory, save on leave and periodically.** Why: DataStore requests are rate limited; per-change writes exhaust the budget and fail.
- **Wrap every call in `pcall`.** DataStore calls are network requests and can throw.
- **Never give default data after a failed load.** Kick the player with a polite message instead. Why: playing on blank data and then saving overwrites real progress.
- **Use `UpdateAsync` for writes that depend on the stored value.** Its transform function receives the current value, so you can check the lock and version before writing. The function may run more than once and must not yield.
- **Session lock.** Store which server owns the profile. A second server that finds a fresh foreign lock refuses to load. Why: when a player hops servers, the old server's late save could otherwise overwrite newer data, the classic duplication and rollback bug.
- **Retry with increasing delay**, a few attempts, then give up loudly in logs.
- **`game:BindToClose`** must save all remaining players, because on shutdown `PlayerRemoving` may not finish. It has a limited time window, so save players in parallel.
- **Version the schema.** Fill missing fields from a template on load. Why: old saves must survive new features.

## Loading with a lock

```lua
local DataStoreService = game:GetService("DataStoreService")
local store = DataStoreService:GetDataStore("PlayerData_v1")
local LOCK_TIMEOUT = 10 * 60

local function loadProfile(userId: number)
	local key = "player_" .. userId
	for attempt = 1, 5 do
		local loaded = nil
		local ok = pcall(function()
			store:UpdateAsync(key, function(old)
				loaded = nil -- the transform can re-run; forget any earlier attempt
				local data = old or Template.new()
				local lock = data.Lock
				if lock and lock.JobId ~= game.JobId and os.time() - lock.Time < LOCK_TIMEOUT then
					return nil -- cancel the write: another server owns this session
				end
				data.Lock = { JobId = game.JobId, Time = os.time() }
				loaded = data
				return data
			end)
		end)
		if ok and loaded then
			return loaded
		end
		task.wait(2 ^ attempt)
	end
	return nil -- caller kicks the player
end
```

On save, write the profile through `UpdateAsync` again, refusing if the stored lock belongs to another server; on final save, clear the lock. Refresh the lock time during periodic autosaves so it does not expire mid-session.

## Shutdown

```lua
game:BindToClose(function()
	local pending = 0
	for _, player in Players:GetPlayers() do
		pending += 1
		task.spawn(function()
			pcall(Profiles.saveAndRelease, player) -- an error must not skip the decrement
			pending -= 1
		end)
	end
	while pending > 0 do task.wait() end
end)
```

## Testing

Enable Studio access to API services in game settings to test saving, and use a separate store name for testing. See [[Studio Test Modes]]. Purchases must be recorded in the same profile; see [[ProcessReceipt Idempotency]].

## Check before you hand off

- A failed load kicks the player and never saves.
- Every DataStore call is inside `pcall` with retries.
- A session lock is written on load, refreshed on autosave and cleared on release.
- `BindToClose` saves all players in parallel.
- Rejoining quickly, and stopping the server with players inside, both preserve data in a test.
