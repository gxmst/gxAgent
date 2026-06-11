# 项目维护指南

## 清理编译缓存

### Rust 编译缓存 (src-tauri/target)
```bash
# 清理命令
rm -rf src-tauri/target

# 或使用 cargo
cd src-tauri && cargo clean
```

**说明**：
- Rust 的 target 目录会占用 15-20GB 空间
- 包含所有编译的中间文件和依赖缓存
- 删除后下次编译会重新构建（约2-5分钟）

### Node 模块缓存 (node_modules)
```bash
rm -rf node_modules
npm install  # 重新安装
```

**说明**：
- 通常占用 200-500MB
- 包含所有 npm 依赖

## 定期维护

### 每月一次
- 运行 `cargo clean` 清理 Rust 缓存
- 检查日志文件大小

### 开发建议
- 添加 `target/` 到 `.gitignore`（已添加）
- 不要提交编译产物到 git
- 发布时使用 Release 构建

## 项目大小参考
```
清理前: ~19GB
清理后: ~20MB

正常开发: ~50MB (包含 node_modules)
完整构建: ~15GB (包含 target/)
```

## 自动化清理

**package.json 添加脚本**：
```json
{
  "scripts": {
    "clean": "rm -rf src-tauri/target node_modules dist",
    "clean:rust": "cd src-tauri && cargo clean",
    "clean:all": "npm run clean && npm install"
  }
}
```

使用：`npm run clean:rust`
