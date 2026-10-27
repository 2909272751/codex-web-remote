# 接管中断修复验收（2026-10-20）

目标：接管不能使 Web 自身退出；不依赖桌面 Codex 的进程树或 Job 生命周期；保留已有功能与用户数据。当前只交付本机运行文件，不打包、发布或推送。

## 已观察事实

- 旧服务 14:23:54 仅记录 takeover-requested，之后本机18888拒绝连接，启动器和Node都不在；桌面在14:24:33重新启动。无同时间的应用崩溃/Defender事件。
- 旧部署从Codex执行环境直接Start-Process；旧接管使用taskkill /T。宿主关联导致误伤高度吻合，但没有终止审计事件，不能声称完全确定原始终止者。
- 当前执行环境存在kill-on-close Job，未启用silent-breakaway；没有显式隔离时，普通子进程存在随宿主消失的风险。

## 实现与验收

- [x] 有界的真实进程表；桌面快照与结束前再次核对名称/路径/启动时间；PID重用保护。
- [x] 任一桌面目标是网关祖先时，拒绝整个关闭动作；正常关闭窗口也先保护。
- [x] 按经核验的叶子至根结束目标，不使用taskkill /T；日志记录安全计划和接管阶段。
- [x] WMI broker独立启动，显式breakaway、隐藏窗口、同用户会话核验；不增加自启任务或修改FRP。
- [x] 活跃长任务仍视为忙碌；安静的陈旧标记可释放；中止/失败生命周期关闭活动标记。
- [x] 真实Windows临时进程树：危险祖先拒绝且双方存活、正常树结束、PID重用安全。
- [x] 真实kill-on-close Job：仅结束临时宿主，普通子进程被系统清理，WMI独立子进程存活，Session1。
- [x] 既有代码/队列/项目/UI等受影响回归：check、control、ui-performance、pwa、projects、experience，以及真实Codex integration通过。
- [x] 本机独立启动、13个运行文件SHA256校验、状态/只读/上传烟测。最终备份D:\CodexWebRemote\.backup-20261020-155113。
- [x] 实际域名liuhaobin.top:44077：首页/认证/只读列表/上传均200；测试附件已清理。
- [x] 有真实桌面任务运行时经域名请求接管，返回409 DESKTOP_BUSY，网关PID不变、桌面保留、transition释放。

## 最终运行证据

- 运行版本2.1.0-preview.2，端口18888。仅有本安装目录的一组启动器5588、网关36932；启动器父进程10940为WmiPrvSE，同用户Session1。
- IsProcessInJob核验：启动器不属于任何Job；网关作为启动器子进程仍显示属于某个Job，不能据此断言所有进程都没有Job。桌面/执行器Job分离机制另由真实kill-on-close临时宿主实验验证。
- 设置文件仍为568字节、修改时间2026-10-19 21:11:12；未替换EXE、未改密码/端口/账号/FRP；没有打包、发布或推送。
- PowerShell/协议请求本身有超时，但不通过Promise.race或看门狗提前释放接管锁；必须等待实际操作结束，避免迟到的结束进程动作与下一次接管并行。
- 失败接管会无条件停止后端重试，即使它尚未ready，防止失败之后悄悄再启动。
- 普通退出/信号有日志；Windows硬终止不会执行JS退出回调，不宣称日志能捕获所有强杀。
- 当前真实桌面正在执行本任务，因此没有为测试而强关用户桌面；空闲关闭路径的实际结束动作由隔离Windows进程树/Job测试覆盖。前轮平板/高分屏视觉复测仍按experience-ledger记录待测，不因本轮服务烟测自动标记通过。

所有关闭行为测试只作用于本次隔离创建的临时进程；不强杀当前桌面用户任务。Windows独立启动依据：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Win32_ProcessStartup](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup)。
