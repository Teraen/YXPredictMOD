# Elo API 与匿名榜

**[角色 Elo 强度榜](https://elo.kaigua.vip/elo/characters/)** 默认展示百家之道第三期，采用换角校正 Elo（`within`）。页面可切换[第一期](https://elo.kaigua.vip/elo/characters/?phase=1)与[第二期](https://elo.kaigua.vip/elo/characters/?phase=2)。北京时间10月15日11:00、10月22日14:00、10月29日14:00分别起算，季前赛计入0局。第一、二期封存。第三期每10分钟开始重算，按开局和结算时间顺序逐局更新，完整重放可接纳迟到和被更正的身份事实，避免增量重复计分。总体分等权合并3000–5999与6000及以上两段，玩家数分段列出。

正式页只读取同域 `season.json`。来源服务器运行 `season_scores.py`，从本赛季分期索引按字段白名单导出三期的角色分、出场人次和玩家数。网站的 `yx-season-board-feed.timer` 每分钟通过限定来源地址和只读导出命令的专用 SSH 密钥拉取结果，核对时期、算法和角色名单，再原子发布。打开的页面每分钟检查新结果，15秒请求超时后允许重试，超过20分钟未生成新结果时提示延迟。无效或过时的代次保留上一份成功快照。

来源服务器的定时器配置在 `systemd/yx-patch-rating-study.timer`，仍运行既有评分服务，CPU、内存限制和版本边界检查保持生效。systemd不会并行启动同一个服务，单次若超过10分钟，不会叠加计算。网站发布只读取已经完成的匿名结果，不发游戏请求。评分代码与每日锁定预测保持原样，仅提高运行频率。

个人榜的网页读取 `/elo/public/leaderboard.json`，由 `public_snapshot.py` 从完整合并评分快照预先生成。只包含前100名的三项数值及汇总时间，无身份和复盘字段，文件小于32KB，由Caddy静态提供，刷新无需在API进程内重新加载十多万人的私有快照。生产部署在 `yx-elo-update.service` 增加 `ExecStartPost=/opt/yx-elo/venv/bin/python /opt/yx-elo/public_snapshot.py --snapshot /var/lib/yx-elo/snapshot.json --output <网页目录>/elo/public/leaderboard.json --lookup-db /var/lib/yx-elo/ratings.sqlite3`，并将该公开目录加入 `ReadWritePaths`，目录由 `yx-elo` 写入、Caddy只读。只在重算成功后发布，采用原子替换，失败保留上次成功结果。首次切换网页前须先成功导出。私有快照与索引仍在原有受限目录，独立UID API响应格式保持不变。开发用的独立Python页面为此URL保留同等匿名输出回退，生产由Caddy静态路由承接。

`query_store.py` 把同一代评分保存为只读SQLite索引。生产API使用 `api.py --lookup-db /var/lib/yx-elo/ratings.sqlite3 --uid-key-file /var/lib/yx-elo/uid-hmac.key`，单个/八人查询按身份主键读取，不全量扫描或缓存私有JSON。旧后缀分片有单独索引，匿名榜也已预计算。每次请求只打开一个只读连接，发布新代次时现有请求仍读原文件，后续请求读新文件，避免换代时阻塞。该数据库0600、不在网页目录，不允许网页下载；UID接口原有能力不扩大。模型和前100名排序不变，未新增昵称搜索。

[副职参考](https://elo.kaigua.vip/elo/characters/reference.html) 单独使用旧版公式，原两分钟汇总定时器继续维护 `live.json`，`window.json` 留存固定快照。旧链接中明确请求固定快照或副职的查询参数会转入该页，原实时角色榜链接打开第三期。

首次部署前，在来源服务器安装只读导出器，并在网站服务器预置 `/etc/yx-character-board/source_key` 和已经核实主机指纹的 `known_hosts`。密钥在来源端只允许网站服务器的地址和强制命令 `/usr/bin/python3 -I -B /opt/yx-patch-rating-study/public_season_scores.py`，禁用转发、终端和交互命令。`install_character_board.py` 安装页面、两个镜像定时器及站内入口。`tests/CharacterEloBrowserChecks.cjs` 逐项核对三期分数、查询链接、手机宽度及匿名字段。

本目录是独立的只读数据适配器、OpenSkill 计算器与 API。它不登录游戏、不加入观战、不发送游戏请求，也不修改身份采集服务。部署在赌马同服务器，域名 `https://elo.kaigua.vip`；域名恢复原来的卡牌/流派数据站及匿名Elo榜；MOD查询继续使用独立API。

## 数据与边界

- 初始状态使用原项目公开的 [elo-state-seed](https://github.com/raymondwrw/yxp-card-stats/releases/tag/elo-state-seed)，2026-10-23 附件，SHA256 `6a180fdfc218565f85c9371eb3b71d05b8206d8cd11d3cc4e51f0dfcf5c80398`。115,567 个原始24位UID，包含完整 mu/sigma；不是从网页取整分数反推模型。
- 旧项目当前16位标识是私密密钥 HMAC-SHA256 截断，不是普通 SHA256。原作者提供的密钥已用72817个已知身份验证，使用密钥文本的UTF-8字节，不作hex解码。密钥只留服务器0600私有文件，不进入MOD、网页、Git或API响应。不按昵称匹配。先按原始种子的已处理分片清单恢复遗漏旧对局，再接入已确认的新 UID↔复盘位置及本人积分证据。
- `export.py` 对身份库开启 `mode=ro`、`query_only` 和同一读事务。仅发布身份凭据与当前报告逐字段一致、无冲突、同局至少两名真人的记录。最终名次来自已确认的 `record-player-N` 位置，不从根 `battleRank`、命元或资料分猜测身份。
- 合并普通天梯/道心到同一 OpenSkill Plackett-Luce 模型；每次从固定种子将恢复的旧历史和新事实按对局ID合并、按玩家身份去重后重建，迟到、修正和撤回证据不会重复计分；同一局新增的已确认玩家会补入同一局，不重复整局。机器人不进入模型；单真人局不更新，与原模型口径一致。
- 这是已观测且可确认的记录，不代表全服、全历史或所有私密房覆盖。源暂未提供赛季ID，不推测新赛季，不凭日期添加赛季重置。API明确公开来源时间与覆盖不完整。
- 历史种子、事实导出、运行时评分与私钥仅在私有数据目录，不提交仓库。

## 接口

`GET https://elo.kaigua.vip/api/v1/ratings?uid=<24位小写hex>`：传一个UID，只返回这个玩家的资料，不需要拉榜单或分片。结果为 `{ "所查询的UID": { "name": "昵称", "rating": 技术分, "cons": 保守分, "sigma": 不确定性, "games": 计分场数, "dx": 道心场数, "last": 最后计分时间毫秒, ... } }`。尚未收录时返回HTTP200和 `{}`，非法UID返回400，不能把默认3000当作已收录。

`GET /api/v1/ratings?uid=<UID1>&uid=<UID2>`：同一接口可重复传入 `uid`，最多8人，只返回查到的玩家。MOD与赛马服务器现有客户端已经调用这个接口，无需更新客户端即可使用索引加速。

`GET /api/v1/status` 或 `/healthz`：模型、种子时间、源时间、已更新局数、过期状态与覆盖说明。

`GET /data/elo/p/<末两位>.json`：原始UID旧版MOD兼容接口，与八人批量接口使用同一份统一评分。

## 运行

在独立虚拟环境安装 `requirements.txt`。`api.py --snapshot <snapshot.json>` 默认只监听回环8124，前置 Caddy 提供 HTTPS 和自动续期。

`update.py --seed <seed.json> --source-command <command.json> --output <snapshot.json>` 使用配置中的固定 argv 获取只读导出。生产通过专用、来源IP限制、forced-command SSH密钥运行 `export.py --database <身份库>`；该密钥没有交互shell或转发权限。不要复制采集器票据或原管理员私钥。建议独立 systemd oneshot 与15分钟 timer，失败保留上一完整快照。

`source-command` 是服务器私有配置，不接收网页参数。源库和采集程序不因本服务而启动、停止或更新。种子导入应先核对上述 SHA256，并使用禁止 `find_class` 的 data-only pickle 读取器；不要对未知文件直接执行 `pickle.load`。

验证：`python -m unittest discover -s server/elo -p 'test_*.py'`。原模型与 API 参考：[原项目说明](https://github.com/raymondwrw/yxp-card-stats/tree/main/pipeline/elo)、[OpenSkill 官方文档](https://openskill.me/en/v6.1.3/manual.html)。计算适配器为本项目独立实现，未复制原项目Python代码。

## 旧16位资料回查

`legacy.py --output <legacy.json> --primary <snapshot.json> --uid-key-file <private-key-file>` 缓存原项目256个公开分片，剔除共享匿名槽位及历史大数组；整批校验完成后原子替换。前后导出代次必须相同，且密钥至少匹配1000个已知原始UID（小样本要求全部匹配）。失败保留上次缓存；同代次复用缓存，每15分钟独立刷新，不占用身份采集器。

API加 `--legacy-snapshot <legacy.json> --uid-key-file <private-key-file>` 配置服务器端HMAC回查。查询仍只收原始24位UID，返回仍按原UID索引。正式合并快照设置historyMerged后，只查询统一重算结果；旧评分导出只作历史覆盖校验，不作为缺失历史的替代，也不从取整分数反推mu/sigma。完整mu/sigma由原始种子、恢复旧对局和已确认新事实统一计算。仅未合并的旧格式快照保留按时间择新的兼容行为，并以origin=legacy-hmac及sourceAt标明旧资料来源；此行为不用于正式合并榜。

同服务器旧MOD原始UID分片接口使用统一重算结果；分片只能枚举已确认的原始UID，不能逆推未知哈希。八人批量接口也可用服务器私有HMAC查询尚未还原raw UID的历史人物。服务器私有配置路径示例为`/var/lib/yx-elo/uid-hmac.key`，不要将密钥写进启动命令参数。密钥格式虽是64位hex文本，算法使用文本本身。

## 匿名网页

匿名榜为`/elo/`，根页恢复原数据站入口，卡牌与流派继续使用原站静态素材。自有展示适配器只调用`GET /api/v1/leaderboard?offset=0&limit=100`，返回`rows`中的conservative/uncertainty/technical三项数值、兼容的`scores`数值数组及total/offset/limit/updatedAt/minGames/activeDays；响应没有玩家名、UID、哈希、行标识或个人详情链接。前端不读取姓名索引、玩家资料分片、不登录、不发送凭据；旧`/data/elo/names.json`与`top.json`入口返回404。MOD的指定UID查询及兼容分片仍作为独立API保留，不被网页调用。

榜单沿用原站至少30场、近30天活跃的口径，仅展示原版保守分最高的100名（技术分−2×不确定度），列表显示保守分、不确定性、技术分三列，突出保守分，移除翻页。服务端也在切页前截断前100名，offset≥100返回空数组，total最多100；同一玩家的新旧对局按私有HMAC统一身份，未知原始UID的历史参与者仍参与模型计算；同局同人只算一次。数值结果按快照代次缓存，避免每页重复计算；全榜不暴露稳定身份标识。API状态模式为anonymous-web-and-api。

`api.py`自带不依赖原站源码的匿名独立页面；部署原站时，以自有`web/elo.js`替换原Elo展示模块，启用入口，并覆盖旧身份索引路由。原站完整源码/素材未复制进本仓库。浏览器回归`tests/AnonymousEloBrowserChecks.cjs`检查响应字段白名单、无玩家搜索/详情、无旧身份数据请求、前100名上限、无翻页及390px布局；用ELO_WEB_URL指定待验页面。

计分核心以原版代码生成的24局、8人、含赛季切换的固定向量验证；技术分/不确定度一致，保守分浮点差异小于1e-9。新事实缺少赛季ID时不伪造重置，数据采集筛选与旧来源不同，不能承诺全历史结果完全一致。匿名榜按原版保守分排序并重点显示保守分，同时列出不确定性与技术分；统一重算模型以完整精度计算cons。活跃窗口以已计分对局时间为准，而非抓取时间。

## 合并旧历史与新对局

原始完整状态的已处理分片止于34025000；补回未处理分片后再计算新记录，不能在两份已发表分数之间择新。`import_history.py`在有pyarrow的导入机，从固定HuggingFace提交读取未处理分片的games/players/names，仅接收真实self-record、排除AI和共享匿名槽位，产物保存在私有目录。生产只需该JSON，不依赖pyarrow。

`update.py`增加`--history <history.json> --uid-key-file <private-key-file>`。`merge.py`先统一raw UID与16位HMAC身份，按game ID与玩家去重；一致重复只算一次，新增玩家补入同局，矛盾名次/赛季中止发布。真实同名次保留原模型的平局处理。已证明属于未处理分片的43场较早结束对局仍补算，不能被全局时间截止误删。

未能还原raw UID的历史人物以私有HMAC身份参与计分，匿名榜照常包含其评分；以后取得raw UID会自动合并到同一人物。快照只在完整重算和校验后原子替换；失败保留上一完整版本。验证包含旧+新场数累加、raw/hash统一、同局去重/补人、冲突、平局、早结束历史、未知历史人物及接口不能被旧评分覆盖。

首次生产合并使用固定数据提交`a1d0b935c8f8e4267317c3b49e76bd976c67eb1f`：54,337场历史候选中，排除共享匿名身份和不足两名已确认真人后，45,558场参与更新，再加入19,425场新确认对局，合计重算64,983场。原始种子已包含的更早历史仍保留；上述数字不含种子内对局。旧公开榜73,244个账号全部保留，逐账号场数均未减少。24组Python检查和生产匿名网页检查通过，未改动采集器或赌马账本。
