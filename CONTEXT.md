# ErrAnalyst Context

ErrAnalyst captures terminal errors, analyzes them with an LLM, and helps the user understand the root cause and fix.

## Language

**错误历史**:
过去捕获到的错误及其分析结果的记录集合，是本地缓存数据的展示形态。
_Avoid_: 历史记录、最近错误

**本地缓存**:
保存在本机的错误分析结果，用于同类错误再次出现时复用或按需查阅，与侧边栏展示解耦。
_Avoid_: 缓存列表、历史数据

**错误分析视图**:
错误发生时在侧边栏自动展示的分析界面，是当前分析结果的唯一展示位置。
_Avoid_: 分析面板、旁侧窗口

**缓存查阅**:
用户通过命令按需选择缓存条目并查看其分析结果的入口，不构成常驻列表。
_Avoid_: 历史列表、最近错误
