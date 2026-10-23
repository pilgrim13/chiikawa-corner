# Prototype contract

Socket.IO server, default port 47831. All request handlers use ack `{ok:true,data:{...}}` or `{ok:false,error:"Korean user-facing message",code?:string}`. IDs server generated. `room:state` emits RoomSnapshot, `room:removed` emits `{reason:string}`, and `chat:message` emits ChatMessage. All times epoch milliseconds. RoomSnapshot retains `pending: []` for older clients; new joins do not create approval requests.

- `room:create` payload `{nickname,character,name?}` -> `{room,session}`
- `room:join` payload `{code,nickname,character}` -> `{room,session}` (immediate admission; no host approval). The server checks the code, room lock, 8-member limit, and presence of an online room member before admitting the caller. It also emits `join:approved` with the same `{room,session}` before the ACK so older installed clients enter without an app update.
- `room:resume` payload `{roomId,token}` -> `{room,session}`
- `room:leave` payload `{}` -> `{}`
- `room:kick` payload `{memberId}` -> `{code}`; the invitation code rotates before the member is removed, so the previous code cannot be reused to return.
- `room:lock` payload `{locked:boolean}` -> `{}`
- `room:rotate-code` payload `{}` -> `{code}`
- `room:transfer` payload `{memberId}` -> `{}`
- `profile:update` payload `{nickname,character}` -> `{}`
- `chat:send` payload `{clientId,text}` -> `{message}` (deduplicate per member and clientId; max 200 chars)

Frontend uses `shared/protocol.ts`. Room/session credentials kept in localStorage for prototype; only room code (no tokens) in invitations. Invitation format `치이카와 모퉁이 | <SERVER_URL> | <ROOM_CODE>`; accepting pasted full invitation auto-selects server. Web invitations use `<SERVER_URL>/?join=<ROOM_CODE>`. Browser and current Mac/Windows app defaults point to the same server, `https://junnyeonglee-macmini.taile9e6e.ts.net/chiikawa`, so a code works across them. Desktop configuration comes from `window.corner.getConfig().serverUrl`; browser fallback uses VITE_SERVER_URL or its origin plus the `/chiikawa` base path when present. Saved settings may override the default. The browser edition supports the shared room, garden, and supported Document Picture-in-Picture chat window; desktop overlays require the installed app.

Rooms, recent chat, and resume credentials exist only in server memory. Restarting the server removes all rooms and invalidates old sessions; users must create a new room and share its new code. Client reload or app update can resume an existing room only while that server session still exists.

Main handles Electron overlay updates using preload methods typed in protocol.ts. Renderer routes `?view=overlay` to overlay, otherwise full onboarding/chat UI. It calls setOverlay on room/member/size/quiet changes. Overlay listens onOverlay and draws all members from its received state. Selectable character ids are `chiikawa`, `hachiware`, `usagi`, `momonga`, `kurimanju`, `shisa`, `rakko`, and `furuhonya`; each has a PNG under `/characters/<id>.png`. Use relative-compatible asset URLs (Vite BASE_URL) for packaged file://.

Root owns package/config/electron/scripts/shared. Design agent owns `src/styles.css`, `public/characters/*`, visual asset manifest and optional design notes. Renderer agent owns src except styles.css and index.html. Server agent owns server and tests/server*. All avoid other files unless coordinated.
