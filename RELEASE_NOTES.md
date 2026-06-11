# gxAgent v1.1.0

## 🚀 新特性

### 工具并行执行
- **性能提升 30-70%**：多个工具同时执行，不再串行等待
- 3个工具从 6秒 → 2秒
- 使用 `tokio::spawn` + `futures::join_all` 实现

### 完整功能
- ✅ 会话导入/导出
- ✅ 自定义右键菜单（全局 + 会话）
- ✅ 工具调用统计
- ✅ 命令联想（输入 `/` 触发）
- ✅ 快捷键（Ctrl+K 新建对话）
- ✅ 自动保存草稿
- ✅ 工具超时延长到 5 分钟
- ✅ 自定义图标（猫龟头像）

## 📦 下载

### Windows

**安装包版（推荐）**：
- 自动安装 WebView2 依赖
- 创建快捷方式
- 支持卸载

**便携版**：
- 单 exe 文件
- 需要手动安装 [WebView2](https://go.microsoft.com/fwlink/?linkid=2124701)

## 🔧 系统要求

- Windows 10/11 (64位)
- Edge WebView2 运行时

## 📝 完整更新日志

查看 [CHANGELOG.md](https://github.com/gxmst/gxAgent/blob/main/docs/CHANGELOG.md)

## 🐛 已知问题

- MCP 工具仍为串行执行
- 托盘菜单使用已废弃 API（不影响使用）

---

**首次发布**？查看[使用文档](https://github.com/gxmst/gxAgent)
