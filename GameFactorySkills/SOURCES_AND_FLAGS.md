# Sources And Flags
> What was read to build this library, what could not be opened, and what looked risky. Nothing from any source was installed or run.

## Could not open
- create.roblox.com/docs/production/game-design/starter-pack-design: the address redirects to the game design index and no starter pack article was found. Starter pack guidance in skill 06 comes from Roblox's other monetization pages.

## Only partly read
- All GitHub repositories: the repository web pages and file listings were refused from this environment, so files were read one by one by following paths named in each README. File lists and last-update dates could not be verified, and files a README does not mention may have been missed.
- Roblox/creator-docs: far too large to read whole; only the security, performance, data, monetization, analytics, testing and mobile pages were read.
- The four larger Group A skill packs: the main skill files were read; many sub-files were not.
- Video 5 of the eight YouTube videos (a two-hour course): the transcript was cut off about where its UI section begins.
- All eight videos were studied from spoken words only. The picture was not available.

## Flags
1. boshyxd/robloxstudio-mcp: archived by its author, who says he lost access to the npm account, yet the install command pulls the newest package without asking. Its install guide calls the plugin read-only while the code includes tools that run code, edit scripts, delete objects and upload assets. It listens on every network interface by default and can read a Roblox login cookie. Do not install.
2. ewro/didntwatch: its skill tells the agent to hide from the user how it works, pre-approves its own script so no permission prompt appears, and reads browser YouTube cookies. Do not copy this pattern.
3. ZeroPointRepo/youtube-skills: its setup has the agent collect the user's email, register an account with a third-party service and write an API key into shell files.
4. khou/watch-video: tells any agent that opens the repo to install it, and installs system software on first run without a separate confirmation.
5. MSayib/roblox-dev-skill: quick install pipes a remote script straight into a shell, and its skill tells the agent to run checks without asking.
6. mikefilsaime-groove/yt-dlp-superpowers: installer deletes an existing skills folder and one skill reads a credentials file from the home directory.
7. bradautomates/claude-video: setup invites pasting an API key into chat and can upload videos to a third party.
8. Several skill packs (AshExplained, fizzyhex, christopher-buss, zilibobi, m4bwav, EL4CTEO) tell the reader to add plugin marketplaces, change agent settings, or write into the agent's configuration files. These are ordinary install steps, not attacks, but none were followed.
9. Videos 2, 3 and 8 are promotions (video 3 is openly sponsored) for a paid UI generator or a Discord download. Video 5 walks through installing add-ons, creating a Roblox API key with broad permissions, and downloading a program from the creator's own site. None of that was done.
10. One reader made the allowed file-listing request and got back a message telling it to request repository access with a tool. It did not.
11. centau/vide: one tutorial page has sample code with errors, so its examples were not reused.

## Lessons from launched games
Add dated lessons here after each launch.
