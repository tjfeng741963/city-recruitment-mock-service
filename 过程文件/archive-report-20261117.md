# 面试档案验证 · interview 字段 + agent_archive（2026-11-17）

session_key：sim:archive-1794879717463

面试者：包吃住吗？
Agent：福利3：线路就近安排上岗，包吃三餐包住宿，被褥和工服都是免费提供，面试当天可入住+饭堂吃饭。
  〔interview JSON〕date=(空) time=(空) confirmed=false
  〔档案〕姓名=- 电话=- 日期=- 时段=- 已定=false

面试者：可以，明天上午过来面试。我叫王五，13711112222
Agent：好的王五，明天11月18日上午10点过来面试就行，地址我发您，人过来即可，被褥工服都免费提供，面试完当天就能安排住宿和吃饭。
  〔interview JSON〕date=2026-11-18 time=10:00 confirmed=true
  〔档案〕姓名=王五 电话=13711112222 日期=2026-11-18 时段=10:00 已定=true

面试者：等等，我明天有事，改到后天上午吧
Agent：好的，改到11月19日上午10点，地址还是那个，到时候过来面试就行，人过来即可，被褥工服都免费提供，面试完当天就能安排住宿和吃饭。
  〔interview JSON〕date=2026-11-19 time=10:00 confirmed=true
  〔档案〕姓名=王五 电话=13711112222 日期=2026-11-19 时段=10:00 已定=true

面试者：后天下午2点行不行？上午赶不过去
Agent：可以的，那就定11月19日下午2点，您到时候过来面试就行，人过来即可，被褥工服都免费提供，面试完当天就能安排住宿和吃饭。
  〔interview JSON〕date=2026-11-19 time=14:00 confirmed=true
  〔档案〕姓名=王五 电话=13711112222 日期=2026-11-19 时段=14:00 已定=true

## 最终档案（GET /api/v1/agent/archive）

```json
{
  "session_key": "sim:archive-1794879717463",
  "position_id": 1,
  "name": "王五",
  "phone": "13711112222",
  "city": "深圳",
  "interview_date": "2026-11-19",
  "interview_time": "14:00",
  "interview_confirmed": true,
  "updated_at": "2026-11-17 01:42:01"
}
```