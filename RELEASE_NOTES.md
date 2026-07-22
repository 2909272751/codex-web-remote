# Codex Web Remote v1.4.7

## Public upload reliability

- Fixed file uploads through HTTP 88frp addresses in Edge on both desktop and mobile. The Web UI now has a safe client-ID fallback when browsers do not expose `crypto.randomUUID()` outside a secure context.
- Attachments can be prepared while a task snapshot is still synchronizing, instead of leaving the attach button disabled during background refresh.
- Refreshed the PWA/cache asset version so updated upload behavior reaches existing browsers reliably.
- Revalidated public-address upload with real Edge desktop and mobile viewports, including file picker, upload response and attachment-ready state.

---

# Codex Web Remote v1.4.6

## Web remote parity and setup polish

- Restored live desktop-output sync in read-only mode with incremental desktop log forwarding plus debounced snapshot reconciliation.
- Read-only snapshots now parse newer Codex `response_item` records, including command/tool output, so remote progress is less likely to appear stuck.
- Added browser-side "remember password" login option for self-hosted personal use.
- Added clearer launcher access to port/password settings from the dashboard and tray menu.
- Added account switching support for Codex account backups and safer Web/Desktop restart messaging.
- Fixed launcher self-test isolation so diagnostics no longer touch the real local settings file.
- Hardened the Web gateway against uncaught async errors, app-server pipe failures and WebSocket send failures, reducing silent exits and apparent hangs.
- Made upload preparation available before takeover while still requiring control before sending messages, so remote devices can attach files in advance without interrupting the desktop App.
- Added attachment ownership checks, malformed filename handling and streaming image previews to avoid cross-session attachment reuse, 500 errors and large-image memory spikes.
- Improved launcher recovery when the Node gateway process is alive but unhealthy by restarting the gateway instead of reporting a false-ready state.
- Preserved mobile/tablet/desktop layout fixes, dark/light contrast hardening, account usage snapshots and GitHub update checks.

---

# Codex Web Remote v1.4.4

## Experience and reliability

- Faster task switching with bounded history rendering and cached snapshots.
- Upload progress, cancel/retry, per-task draft recovery, shared Web control state and safer reconnect recovery.
- Responsive verification for phone, tablet and high-resolution desktop layouts.
- Account usage now distinguishes official account totals from gateway-observed input, output and cached-token detail.

---

# Codex Web Remote v1.4.3

## 妗岄潰 App 淇濇姢

- Web 妯″紡涓嬫娴嬪埌妗岄潰 Codex 鍚姩鏃讹紝濡傛灉 Web 绌洪棽锛屼細鑷姩鍋滄 Web app-server 骞惰璺粰妗岄潰 App銆?- Web 鏈夎繍琛屼换鍔°€佹帓闃熸秷鎭€佹彁浜ゆ垨瀹℃壒鏃朵笉浼氳嚜鍔ㄥ垏鎹紝涔熺粷涓嶄細缁撴潫鏂板惎鍔ㄧ殑妗岄潰杩涚▼銆?- 鏂板鎺ョ銆侀噴鏀俱€佹闈㈠啿绐佷笌鑷姩璁╄矾瀹¤璁板綍锛屼究浜庣‘璁ゆ搷浣滄潵婧愬拰鍙戠敓鏃堕棿銆?- 鏂板鎺у埗绛栫暐鍙婂畬鏁存湇鍔″洖褰掓祴璇曪紝楠岃瘉绌洪棽鑷姩璁╄矾銆佺箒蹇欑姸鎬佷繚鎸佸拰澶氳澶囨帶鍒朵笉鍙楀奖鍝嶃€?
---

## v1.4.2

## 淇

- 淇 Web 鍚庣閲嶅惎鎴栭噸鏂版帴绠″悗锛屽皻鏈彂閫佺涓€鏉℃秷鎭殑绌轰换鍔′細浠庝换鍔″垪琛ㄦ秷澶辩殑闂銆?- 绌轰换鍔＄幇鍦ㄤ細鍦?Web 鍒楄〃涓寔缁彲瑙侊紱鐐瑰嚮鏃ц褰曟椂浼氳嚜鍔ㄥ垱寤哄悓鐩綍鐨勬浛浠ｄ换鍔″苟鐩存帴杩涘叆瀵硅瘽銆?- 鏂板鐪熷疄閲嶅惎鍥炲綊娴嬭瘯锛岃鐩栤€滃垱寤虹┖浠诲姟銆佹湇鍔￠噸鍚€佸垪琛ㄤ繚鐣欍€佺偣鍑绘仮澶嶃€佹棫璁板綍鏇挎崲鈥濈殑瀹屾暣娴佺▼銆?
---

## v1.4.1

## 淇

- 淇鏂板缓鐨勭┖浠诲姟鍦ㄥ彂閫佺涓€鏉℃秷鎭墠鏃犳硶鐐瑰嚮鎵撳紑鐨勯棶棰樸€?- 瀵?Codex 鈥滃皻鏈疄浣撳寲鈥濈殑鏂颁换鍔℃敼鐢ㄨ交閲忚鍙栵紱绗竴鏉℃秷鎭彂閫佸悗鑷姩鎭㈠瀹屾暣鍘嗗彶銆?- 鏂板鍒涘缓鍚庣珛鍗虫墦寮€绌轰换鍔＄殑鍥炲綊娴嬭瘯銆?
---

## v1.4.0

鏈増鏈ˉ榻?Web 椤圭洰绠＄悊鍜岃繙绋嬩富鏈虹洰褰曢€夋嫨銆?
## 鏂板姛鑳戒笌淇

- 淇 Web 鍙兘娌跨敤鏃т换鍔＄洰褰曘€佹棤娉曟坊鍔犳柊椤圭洰鐨勯棶棰樸€?- 渚ф爮鏂板椤圭洰鍒楄〃锛屽彲鎸夐」鐩瓫閫夋湰鏈轰换鍔°€?- 鏂板涓绘満鐩綍娴忚鍣紝鎵嬫満銆乮Pad 鍜岃繙绋嬬數鑴戝潎鍙祻瑙?Windows 纾佺洏骞堕€夋嫨椤圭洰鏂囦欢澶广€?- 娣诲姞椤圭洰涓嶈姹傚厛鎺ョ Codex锛涢€夋嫨椤圭洰鍚庯紝鏂颁换鍔′細鏄庣‘鍒涘缓鍦ㄨ鐩綍涓€?- 椤圭洰鍚嶇О鍜岃矾寰勬寔涔呬繚瀛橈紝閲嶅惎鍙婅鐩栨洿鏂板悗浠嶇劧淇濈暀銆?- 浠庡垪琛ㄧЩ闄ら」鐩彧绉婚櫎 Web 鍏ュ彛锛屼笉鍒犻櫎婧愮爜鏂囦欢鎴?Codex 鍘嗗彶璁板綍銆?- 鏈嶅姟绔牎楠岄」鐩洰褰曞繀椤诲瓨鍦紝閬垮厤浠诲姟璇缓鍒扮▼搴忓畨瑁呯洰褰曘€?- 浼樺寲妗岄潰銆佸钩鏉垮拰鎵嬫満涓婄殑椤圭洰鍒楄〃涓庣洰褰曢€夋嫨寮圭獥甯冨眬銆?
---

## v1.3.0

鏈増鏈姞鍏?GitHub 鑷姩鏇存柊鍜屼竴閿畨鍏ㄥ崌绾с€?
## 鏂板姛鑳?

- 鎵樼洏鎺у埗涓績鍚姩鏃跺強姣?6 灏忔椂妫€鏌?GitHub 鏈€鏂?Release銆?
- 杩滅▼ Web 妫€娴嬪埌鏂扮増鍚庢樉绀烘洿鏂版í骞呭拰鐗堟湰璇存槑閾炬帴銆?
- 鎵樼洏涓庤繙绋?Web 鍧囧彲鍙戣捣涓€閿洿鏂般€?
- 鑷姩涓嬭浇 Setup 涓?SHA256 鏂囦欢锛屾牎楠屼竴鑷村悗鎵嶈繘鍏ュ畨瑁呫€?
- 浣跨敤瀹夎鐩綍澶栫殑涓存椂鏇存柊鍣紝瀹夊叏鍋滄缃戝叧銆佽鐩栧綋鍓嶅畨瑁呯洰褰曞苟鑷姩閲嶅惎銆?
- 鏈変换鍔¤繍琛屻€佹鍦ㄥ惎鍔ㄦ垨浠嶆湁鎺掗槦娑堟伅鏃讹紝Web 浼氭嫆缁濇洿鏂帮紝閬垮厤浠诲姟涓柇銆?
- 鏇存柊淇濈暀瀵嗙爜銆佺鍙ｃ€佸紑鏈鸿嚜鍚€?8frp 鍦板潃銆佷細璇濆拰娴忚鍣ㄦ暟鎹€?

## 璇存槑

Windows 鏃犳硶鍦ㄨ繘绋嬭繍琛屾湡闂寸湡姝ｇ儹鏇挎崲 EXE锛屽洜姝よ繖閲岄噰鐢ㄢ€滀笅杞戒笌鏍￠獙鏈熼棿涓嶅仠鏈猴紝瀹夎闃舵鐭殏閲嶅惎鈥濈殑鍑嗙儹鏇存柊鏂瑰紡銆?

---

## v1.2.0

鏈増鏈姞鍏ュ Web 璁惧鍏变韩鎺у埗銆?

## 鏂板姛鑳?

- 鎵嬫満銆乮Pad 鍜岀數鑴戝彲浠ヤ娇鐢ㄥ悇鑷殑 24 灏忔椂鐧诲綍浼氳瘽鍚屾椂鎺у埗 Web Codex銆?
- 涓嶅啀鍑虹幇鈥滃彟涓€涓祻瑙堝櫒姝ｅ湪鎺у埗鈥濆鑷寸殑闀挎湡鍗犵敤銆?
- 涓や釜璁惧鍚屾椂鍚戝悓涓€浠诲姟鍙戦€佹秷鎭椂锛屾湇鍔＄浼氳嚜鍔ㄤ覆琛岋細涓€鏉＄珛鍗宠繍琛岋紝鍙︿竴鏉¤繘鍏ラ槦鍒椼€?
- 鎵€鏈夎澶囧叡浜换鍔＄姸鎬併€佹€濊€冭繘搴︺€佸鎵广€佹帓闃熸秷鎭拰鏂囦欢涓婁紶缁撴灉銆?
- 缁堢妯″紡缁х画淇濇寔鍗曚細璇濊緭鍏ワ紝閬垮厤澶氫釜閿洏鍚屾椂鎿嶄綔鍚屼竴缁堢銆?
- 鏇存柊 PWA 缂撳瓨鐗堟湰锛屽崌绾у悗鎵嬫満浼氳幏鍙栨柊鐨勫叡浜帶鍒剁晫闈€?

## 鍗囩骇

鐩存帴杩愯 v1.2.0 瀹夎鍖呰鐩栧畨瑁呭嵆鍙紝瀵嗙爜銆佺鍙ｃ€佽嚜鍚拰 88frp 鍦板潃閮戒細淇濈暀銆?

---

## v1.1.1

杩欐槸涓€涓帴绠″惎鍔ㄥ吋瀹规€т慨澶嶇増鏈€?

## 淇

- 淇鏂扮數鑴戞病鏈?`node_repl` 鍜?`openaiDeveloperDocs` MCP 閰嶇疆鏃讹紝鎺ョ浼氭姤 `Codex app-server stopped (code=1, signal=none)` 鐨勯棶棰樸€?
- app-server 鎰忓閫€鍑烘椂锛岀綉椤甸敊璇拰鎵樼洏鏃ュ織鐜板湪浼氭樉绀洪€€鍑哄墠鐨勭湡瀹為敊璇紝渚夸簬鎺掓煡涓嶅悓鐢佃剳涓婄殑鐜闂銆?
- 鏂板骞插噣 Codex 閰嶇疆鍥炲綊娴嬭瘯锛岀‘淇濆畨瑁呭寘涓嶄緷璧栧紑鍙戠數鑴戠嫭鏈夌殑閰嶇疆銆?

## 瀹夎

宸插畨瑁?v1.1.0 鐨勭數鑴戠洿鎺ヨ繍琛?v1.1.1 瀹夎鍖呰鐩栧崌绾у嵆鍙紝瀵嗙爜銆佺鍙ｅ拰 88frp 鍦板潃浼氫繚鐣欍€?

---

## v1.1.0

鏈増鏈皢瀹夎鍜屾棩甯哥鐞嗘敼鎴愬畬鍏ㄥ浘褰㈠寲娴佺▼锛屾櫘閫氱敤鎴蜂笉鍐嶉渶瑕?PowerShell銆丯ode.js 鎴栧懡浠よ銆?

## 鏂板姛鑳?

- 涓枃 `Setup.exe`锛屽弻鍑诲悗鎸夊畨瑁呭悜瀵煎畬鎴愬畨瑁?
- 鍘熺敓 Windows 棣栨璁剧疆鐣岄潰
- 鎵樼洏鎺у埗涓績锛氬惎鍔ㄣ€佸仠姝€侀噸鍚€佹墦寮€缃戦〉鍜屾煡鐪嬫棩蹇?
- 瀵嗙爜浣跨敤 Windows DPAPI 鍔犲瘑淇濆瓨
- 鍥惧舰鍖栦慨鏀瑰瘑鐮併€佺鍙ｃ€丠TTPS Cookie 鍜屽紑鏈哄惎鍔?
- 88frp 閰嶇疆鎻愮ず銆佸叕缃戝湴鍧€淇濆瓨鍜屼簩缁寸爜
- PWA 鏀寔锛屽彲鍦ㄦ墜鏈哄拰 iPad 娣诲姞鍒颁富灞忓箷
- 閰嶇疆涓庣▼搴忔枃浠跺垎绂伙紝瑕嗙洊鍗囩骇涓嶄細涓㈠け璁剧疆
- 鏍囧噯鍗歌浇娴佺▼锛屽嵏杞戒笉浼氬垹闄?Codex 鍘熷浠诲姟

## 瀹夎

1. 瀹夎骞剁櫥褰?Codex Windows App锛岀‘璁よ兘姝ｅ父鎵撳紑浠诲姟銆?
2. 涓嬭浇 `CodexWebRemote-Setup-1.1.1-win-x64.exe`銆?
3. 鍙屽嚮瀹夎锛屽畨瑁呭畬鎴愬悗浼氳嚜鍔ㄦ墦寮€棣栨璁剧疆鐣岄潰銆?
4. 璁剧疆 Web 瀵嗙爜锛岀偣鍑烩€滃畬鎴愯缃苟鍚姩鈥濄€?
5. 鏈満鎵撳紑 `http://127.0.0.1:18888`锛涜繙绋嬭闂椂锛屽皢 88frp 鎸囧悜 `127.0.0.1:18888`銆?

鍏嶅畨瑁呯敤鎴峰彲浠ヤ笅杞?`CodexWebRemote-Portable-1.1.1-win-x64.zip`锛岃В鍘嬪悗鍙屽嚮 `CodexWebRemote.exe`銆?
# Codex Web Remote v1.4.8

## Remote update and version visibility

- Remote-triggered updates now run the installer and restart helper without interactive installer windows.
- The Web sidebar now displays the running Web version even when update checking is unavailable.
- The launcher executable version and Windows manifest are generated from the release version instead of retaining a stale fixed version.

## Previous v1.4.7 changes
