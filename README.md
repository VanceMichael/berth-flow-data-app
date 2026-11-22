# 邮轮客站停留分布与下一班次分流

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

所有时钟为船到港地时间。manifest 的 window 是预约值，notified_until 是此前已报旅客的最迟协助完成承诺。escort 对应需陪同的同行者，缺省表示服务可由场内人员独立完成。start 只是服务开始，pass 表示离开该队列。closed 禁止配置新服务，missing-gate 表示观察不全，二者不等价。从开始到 observation-cutoff 为已采集时段。walkways 是步行段，可走路径按轮椅标志区分，meet 是集合点。
capacity 中一名 helpers 同时最多给一个同行组服务。常规及协助服务的拟用工时可用相容的既往观测估计，缺乏足够资料时用有依据的范围或提示无法比较，不填写固定的等待数字。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。
