# 后台原生 Pi 与用户服务

直接终端启动网关仍可使用，无需 systemd；后台原生 Pi 需要 tmux。可选的 [用户服务示例](../services/pi-mobile-gateway.service.example)用于 systemd Linux。复制到用户服务目录前，替换示例里的 Node、Pi CLI、网关与 Node 所在目录；用 `command -v node`、`command -v pi` 和仓库实际路径获取，Node 版本须满足 package.json。

```sh
mkdir -p ~/.config/systemd/user
cp services/pi-mobile-gateway.service.example ~/.config/systemd/user/pi-mobile-gateway.service
# 编辑文件，替换所有 /ABS/PATH/TO 占位路径
systemctl --user daemon-reload
systemctl --user enable --now pi-mobile-gateway.service
```

用户服务不会自动加载交互 shell 的环境。文件补全还需要 `fd` 或 `fdfind` 位于该服务的 PATH；个人目录安装时也要加入其 bin 路径，不能用交互终端能补全证明服务已配置。需要的环境变量自行配置到本机服务或受保护的 EnvironmentFile，勿提交真实配置或凭据。网关和电脑 CLI 应使用一致的 PI_CODING_AGENT_DIR / PI_MOBILE_BRIDGE_ROOT；后台 Pi 继承网关启动环境，不继承另一个 CLI 的私有启动参数。

## 重启与停止

示例显式设置 KillMode=process。网关启动的 tmux 与原生 Pi 留在同一 cgroup；默认 control-group 会在网关重启时一起终止它们，daemonize 不改变归属。process 使重启只停止网关主进程，后台 Pi 保留；网关恢复后从注册表重新发现原实例、订阅同一会话。客户端仍需重连，不保证零中断。

**停止网关也会保留后台 Pi。** 要结束某个后台实例，先 `pi-mobile attach <sessionId>`，在原生 Pi 中结束当前工作并退出；不要把网关服务 inactive 当作全部资源已回收。`pi-mobile attach` 使用与网关相同的 bridge root，别连接另一个配置目录的 socket。停止或清理前确认没有未结束的工作；不自动杀掉电脑上其他 Pi。

无 systemd 的 Linux、SSH 终端与 tmux 路径仍按原方式使用。服务示例是可选配置，仓库不会自动安装或修改现有服务。独立单元中的真实 BridgeLauncher/Pi 对照验证过默认配置与 process 的生命周期；它不代替手机、真实网络或 Provider 验收。
