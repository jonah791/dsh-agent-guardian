# dsh-agent-guardian

守卫插件（从 dsh-agent-watch 拆分）：web 保活——启动时端口空闲拉起 web、崩溃自愈（快速退出计数+落盘事故）、收养外部 dsh web（零互踢）。崩溃自愈/拉起前也调用沙盒预检（ctx.preflight.run quick 模式，消费 dsh-agent-preflight）——预检不过不拉起（fail-closed）。不负责哨兵监听与重启协调（归 dsh-agent-sentinel）。
