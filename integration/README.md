> 当前0.7.12已改为马币、独立赌马域名和全部账户上榜，并新增每日签到；详见[迁移说明](../docs/duma-migration-checkin.md)。下文为0.7.11接入方式或历史规则说明。

# 接入现有攻略网页登录

网页`server/web/`默认与攻略站同域。它使用原`/v1/guides/login`和`logout`，每次私有请求前从`/v1/guides/prediction-ticket`领取短期身份票，不读取HttpOnly登录Cookie，也不把攻略会话交给房间服务。

`auth-guide-ticket.patch`是本项目自有认证服务`apps/auth-server/src/guides/routes.ts`的最小适配差异。使用`git apply --unidiff-zero integration/auth-guide-ticket.patch`应用（零上下文补丁），或手动移植这两处变更。目标是拥有`registerGuideRoutes`、`service.session()`和同源保护的攻略服务；该文件属于单独的加载器仓库，不是此MOD构建依赖。请按各自认证框架适配，不要安装替换整个认证服务或覆盖已有数据库。

两侧分别注入同一随机32字节十六进制`YX_PREDICTION_BRIDGE_KEY`，以操作系统权限保护。不要复用许可证签名/隐私散列密钥。攻略端验证现有会话及当前授权状态后签发：

```
payload = base64url(JSON({subject, name, expiresAt}))
subject = HMAC-SHA256(bridgeKey, "prediction-web:" + verifiedUidHash).hex()
ticket = payload + "." + HMAC-SHA256(bridgeKey, payload).base64url()
```

`expiresAt`为UTC毫秒，签发后60秒过期。房间端校验签名、64位十六进制subject、未来不超过120秒的期限。密钥在HMAC中先按hex解码，payload按UTF8编码。QQ、机器码、原始UID和许可证令牌均不进入票。签发接口保留`X-Guide-Client: 1`和原有同源检查，返回`{ticket}`；未登录401，未配置密钥503。房间私有请求通过`X-Prediction-Identity`携票，变更请求还要求`X-Prediction-Client: 1`及同源Origin。建议HTTPS，同域部署，勿在代理开启任意跨域凭据访问。

账户关联还需要MOD令牌换取的一次性TP绑定码：5分钟有效，数据库保存成功才消耗，已绑定其他身份的积分账户不可转移。网页登录只改榜单昵称，不能修改分数或上报战果。密钥轮换会改变subject，应先设计账户迁移，不可直接轮换后丢弃既有绑定。
