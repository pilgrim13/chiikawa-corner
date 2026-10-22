# Prototype contract

Socket.IO server, default port 47831. All request handlers use ack `{ok:true,data:{...}}` or `{ok:false,error:"Korean user-facing message",code?:string}`. IDs server generated. `room:state` emits RoomSnapshot (pending only for host), `room:removed` emits `{reason:string}`, `join:approved` emits `{room,session}`, `join:rejected` emits `{reason}`. `chat:message` emits ChatMessage. All times epoch milliseconds.

- `room:create` payload `{nickname,character,name?}` -> `{room,session}`
- `room:join` payload `{code,nickname,character}` -> `{pending:true,requestId}` (host approval always)
- `room:resume` payload `{roomId,token}` -> `{room,session}`
- `room:approve` payload `{requestId}` -> `{}`
- `room:reject` payload `{requestId}` -> `{}`
- `room:leave` payload `{}` -> `{}`
- `room:kick` payload `{memberId}` -> `{}`
- `room:lock` payload `{locked:boolean}` -> `{}`
- `room:rotate-code` payload `{}` -> `{code}`
- `room:transfer` payload `{memberId}` -> `{}`
- `profile:update` payload `{nickname,character}` -> `{}`
- `chat:send` payload `{clientId,text}` -> `{message}` (deduplicate per member and clientId; max 200 chars)

Frontend uses `shared/protocol.ts`. Room/session credentials kept in localStorage for prototype; only room code (no tokens) in invitations. Invitation format `치이카와 모퉁이 | <SERVER_URL> | <ROOM_CODE>`; accepting pasted full invitation auto-selects server. Default server is `window.corner.getConfig().serverUrl` or VITE_SERVER_URL or current origin. Settings may override server URL. Browser fallback is supported for QA/guest preview, desktop overlay requires installed app.

Main handles Electron overlay updates using preload methods typed in protocol.ts. Renderer routes `?view=overlay` to overlay, otherwise full onboarding/chat UI. It calls setOverlay on room/member/size/quiet changes. Overlay listens onOverlay and draws all members from its received state. Renderer and overlay assets at `/characters/chiikawa.png`, `/characters/hachiware.png`, `/characters/usagi.png`. Use relative-compatible asset URLs (Vite BASE_URL) for packaged file://.

Root owns package/config/electron/scripts/shared. Design agent owns `src/styles.css`, `public/characters/*`, visual asset manifest and optional design notes. Renderer agent owns src except styles.css and index.html. Server agent owns server and tests/server*. All avoid other files unless coordinated.
