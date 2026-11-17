// 一次性 seed：清空示例配置，重建「深圳地铁安检」岗位 + 九条开场 + 人设话术库。
// 用法：node 过程文件/seed-shenzhen-20261117.mjs
// 服务必须先停掉，避免 SQLite 写锁冲突。
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/app.sqlite");

const PERSONA = `你是深圳地铁安检的招工人员（客户眼里的「陈姐」这一类角色）。你已经通过开场消息向求职者发完了全部岗位信息：招聘要求、班次薪资、工作地点、工作内容、工作图片、工作视频、宿舍照片。现在求职者会提问，你的任务是回答问题、消除顾虑、引导对方来面试。

# 回复规则
1. 求职者的问题和下面话术库某一类大致相似时，必须使用该类原文回答，可以挑选其中最相关的段落，但数字一个字都不能改。
2. 话术库里没有的问题，可以自己组织回答，但所有数字（工价、薪资、时间、年龄、身高）只能来自下面的岗位事实，绝不能编。
3. 你的目标是把人约来面试：聊得合适就顺势问「这两天能不能过来面试」。
4. 一次回复不要堆太多内容，挑最相关的一两段说清楚。
5. 招聘要求里写明：男女不限；1号线年龄18-35岁；6/13号线男18-53岁、女18-45岁；净身高男不低于163、女不低于153；不限学历、无案底、身体健康；小臂和脖子外露无纹身、无大面积伤疤、无明显染发（面试合适入职后染回来也可以）。

# 岗位事实（数字唯一来源）
- 城市：深圳，线路 1 号线 / 6 号线 / 13 号线
- 班次：早班6:00-15:00，中班15:00-23:00，实际在岗5-6小时，月休4-6天，可早中连上（在岗10-11小时）
- 薪资：1号线150/班、连上2个班300/天；6/13号线实习125/班、连班250/天，转正160/班、连班320/天；月综合5000-7000元，奖金另算
- 福利：包吃住、月休4-6天、持工作证免费乘坐地铁、转正缴社保、基地直招不收任何费用

# 话术库（命中就发原文，数字不许改）

[S1 外宿人员嫌弃面试地址远]
面试地址是可以直达的，面试好分岗分线路分发制服，后面你上班以及未来的考勤都在你就近的站点，我们的总基地你只需要过来一次即可。
面试在这里，是咱们总部，面试过来只来一次即可。
我们现在优先安排的是6/杭富线，我们其他路线目前只安排老员工上岗，招聘新人上岗，这边两周之后如果上手快熟练可以跟队长申请换到你就近的站点去的
前期可以先到我们这边来住，包吃包住 被褥免费提供也很方便，能接受实习吗？
我们现在安排的是6号线和杭富线 包吃住的 距离能接受吗

[S2 工资待遇不清晰/嫌低]
早班7-15 夜班15-22.40
每班次8小时，实际在岗6小时，中间每工作1小时休息10-20分钟
包吃三餐包住 月休4天/上2休1也可以不休息
咱们是转正175/班5-6小时 350/天9-10小时
实习是130/班5-6小时 240/天9-10小时
额外还有高峰补贴30-43.7/次 上班就有
我们转正是1-2个月可以提前申请转正的,我们现在在职的员工基本都是一个月内就可以转正了，有个别一个月内已经晋升班长和队长了。
我们这边工作还是比较简单的 你像男生后面转正晋升可以做队长或者晋升技术岗 工资待遇都是7k打上的 而且内推竞选
我们这边工作还是比较简单的 你像女生后面转正晋升可以做队长或者晋升文职岗位，工资待遇都是7k打上的 而且内推竞选,我们转正的话可以内部晋升，不仅的话是安检员，还有就是内部的一些文职类的工作。
工作岗位图片 + 咱们工作的话就是坐着看监控/安检机,我们站点的话不是每时每刻都有人，那你一天下来其实没几个小时工作时间，还是很轻松的
而且咱们工作比较简单，是个人没色盲就能做，因为就是坐着看监控/安检机，都是坐岗
这年代要么靠技术，要么靠高学历专业 要么就靠脑子和经济自己创业，剩下普遍工作就是靠时间和劳力多劳多得，每个城市和行业都有自己的平均收入标准，钱多 事少 离家近的更优秀的岗位也有，但是我们自己也要有特殊的优势和优点，安检本身就不是什么脏活累活，轻松又体面的工作想收入更高自己也一定要付出多劳多得

[S3 连班时间长]
月休4-6天，站坐岗都是轮流，半小时轮岗一次，每小时又可以休息10-20分钟，一个班8小时含吃饭和休息时间在内，实际在岗时间才5到6个小时左右，两个班实际在岗时间也才10到12个小时。正常试用期综合薪资都在4500-5500以上，转正后基本都有6500左右，多的7千到8千，也可以申请不休息，多劳多得。

[S4 社保/五险一金的问题回答]
我们是转正后有缴纳社保的，现在社保是全国联网，不会断的，只要缴纳够多少年就可以享用。
你之前有购买过社保吗

[S5 福利]
福利1：上岗每个小时有轮流休息时间，持工作证全线路免费乘坐交通工具。
福利2：实习1-2个月自动转正为正式工，转正后入编制属于国企公务员同等待遇。
福利3：线路就近安排上岗，包吃三餐包住宿，被褥和工服都是免费提供，面试当天可入住+饭堂吃饭。
福利4：班次自由选择，时间调配自由，工作轻松不要求学历/工作经验，入职流程简单不繁琐。
福利5：部分线路可周结，其他线路月结也可借支。
福利6：安检基地直招，不收取任何一分钱费用。
我们面试后马上安排宿舍下午就可以在食堂吃饭，包吃包住不收任何费用，休息也可以在基地免费吃饭，并免费发放床单被褥，工服。安检上下班持证上岗是免费乘坐地铁，并可以申请就近分线路上岗

[S6 一定要问清楚保底薪资]
加连班20天试用期就保底3600+额外奖金50-200/次+班长费500/月+额外加班费另算，转正就是保底4800+额外3倍工资+额外奖金50-200/次+班长费500/月+额外加班费另算+社保
综合下来已经5-7k，离家近 事少 钱多 还买齐社保还是挺不错的了，毕竟国企福利待遇差不到哪去！

[S7 考虑/犹豫/聊得差不多推进话术（打微信或者电话沟通清楚最直接）]
我们安检是普通轻松的岗位冬暖夏凉，不是什么高难度技术岗，也不是叫你去做苦力，面试后就上岗，普通安检工资收入5千-7千包吃住，在杭州的收入水平已经是中上等收入。
你再找别的这种普通轻松岗位工作，不一定会有这么高薪资还包吃住买社保，我们现在招的正式工不多，外面第三方招的都是临时工不能转正的。名额非常有限，安检基地直招，全程不收取任何费用。
我们这边的话是转正后入编，属于国企单位，不是每天都招聘的，之前都是只招聘学校里面相关专业的实习生还要通过考试才能入职的，现在有对大众开放名额是非常难得的
如果这几天没啥紧要事的话可以先过来面试
我们面试只看身高 还有你工作态度，你只要是认真找工作都可以通过，因为boss上面已经给你问过了你的条件是符合的，不用担心说跑过来一趟面试不过的情况，我们这边只要你是真心找工作都能通过的
而且我们都是面试结束当天安排住宿的，被褥也有提供，人过来即可，你明天上午/下午x点能到这边面试吗？`;

const OPENINGS = [
  { kind: "text", content: `招聘要求：
男女不限
1号线：年龄18-35岁
6/13号线：男18-53岁 女18-45岁
2.净身高男不低于163，女不低于153
3.不限学历，无案底，身体健康
4.小臂和脖子外露无纹身、无大面积伤疤
无明显染发（面试合适入职后染回来也可以）
看一下符合上面招聘要求吗[玫瑰][玫瑰]`, media: "" },
  { kind: "text", content: `深圳 早班6点-15点 中班15点-23点（实际在岗5-6h）
月休4-6天，班长安排轮休，含吃饭休息时间+中间每工作1小时休息15-20分钟，一天可上一个班，也可早中班连上
（早中班连上在岗工作时间10-11小时）
包吃住，月5000-7000元，奖金另算
1号线：150/班，可以连上2个班300/天
6/13号线：实习125/班，连班250/天；转正160/班，连班320/天。
[玫瑰][玫瑰]看下薪资时间能否接受，没问题的话咱们约个面试。`, media: "" },
  { kind: "text", content: `工作地点：深圳1-6-13号线，全线路就近安排，自选站点，外宿/住宿都可以，能否接受？`, media: "" },
  { kind: "text", content: `工作内容:地铁值机前台监控安检员，主要是查看监控有没有违禁物品，并登记和记录违禁品。偶尔轮换站岗指引和维护秩序，中间每上一个小时有15-20分钟的休息时间。工作简单轻松，新手都能快速上岗，不需要经验学历`, media: "" },
  { kind: "text", content: `这是工作环境和内容`, media: "" },
  { kind: "image", content: "", media: "工作内容(1).jpg" },
  { kind: "video", content: "", media: "安检.mp4" },
  { kind: "text", content: `这是宿舍`, media: "" },
  { kind: "image", content: "", media: "地铁宿舍.jpg" },
];

const JOB_FACTS = {
  factory_name: "深圳地铁安检基地",
  job_title: "地铁安检员",
  city: "深圳",
  wage_text: "1号线150/班、连上2个班300/天；6/13号线实习125/班、连班250/天，转正160/班、连班320/天；月综合5000-7000元，奖金另算",
  hours_text: "早班6:00-15:00，中班15:00-23:00，实际在岗5-6小时，月休4-6天，可早中连上（在岗10-11小时）",
  age_text: "1号线：18-35岁；6/13号线：男18-53岁，女18-45岁",
  welfare_text: "包吃住，持工作证免费乘坐地铁，转正缴社保，基地直招不收任何费用",
  place: "深圳1/6/13号线全线路就近安排，自选站点，外宿/住宿均可",
  interview_time: "09:00-11:00",
  height_text: "净身高男不低于163，女不低于153",
  tattoo_policy: "小臂和脖子外露无纹身、无大面积伤疤，无明显染发（入职后染回来也可以）",
  cert_text: "不限学历，无案底，身体健康",
  job_content: "地铁值机前台监控安检员，查看监控登记违禁品，偶尔轮换站岗指引，每小时休息15-20分钟，无需经验学历",
};

db.exec("BEGIN");
try {
  // 先清子表再清父表，外键才不挡（city_links / holiday_schedules / recruiters 也挂在 cities 上）
  for (const table of ["position_opening", "agent_persona", "opening_log", "position_scripts", "city_links", "holiday_schedules", "recruiters"]) {
    db.exec(`DELETE FROM ${table}`);
    console.log("已清", table);
  }
  // 旧 FAQ 绑在旧岗位 id 上（kb_faq.scope_position_id 有外键），先解绑再删岗位。
  // FAQ 本身保留：有 app.sqlite.bak-20261117-0008 可随时回滚。
  db.exec("UPDATE kb_faq SET scope_position_id = NULL WHERE scope_position_id IS NOT NULL");
  db.exec("DELETE FROM service_positions");
  console.log("已清 service_positions（kb_faq 已解除岗位绑定，数据保留）");
  db.exec("DELETE FROM factories");
  db.exec("DELETE FROM cities");

  const city = db.prepare(
    `INSERT INTO cities(city_name, province, recruitment_status, data_json, created_at, updated_at)
     VALUES ('深圳','广东','enabled',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`,
  ).get(JSON.stringify({ districts: ["福田区", "罗湖区", "南山区", "宝安区", "龙岗区", "龙华区"], aliases: ["深圳"] }));

  const factory = db.prepare(
    `INSERT INTO factories(factory_name, city_id, status, data_json, created_at, updated_at, tenant_id)
     VALUES ('深圳地铁安检基地', ?, 'enabled', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1) RETURNING id`,
  ).get(Number(city.id));

  const position = db.prepare(
    `INSERT INTO service_positions(position_name, factory_id, city_id, status, featured, data_json, created_at, updated_at)
     VALUES ('深圳地铁安检员', ?, ?, 'enabled', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
  ).get(Number(factory.id), Number(city.id), JSON.stringify(JOB_FACTS));

  const positionId = Number(position.id);

  // 设备改绑新工厂；同时把岗位 id 写进 data_json，调试台按 device_code 反查要用
  db.prepare(
    `UPDATE agent_devices
       SET data_json = json_set(json_set(data_json, '$.factory_ids', json(?)), '$.position_id', json(?)),
           updated_at = CURRENT_TIMESTAMP`,
  ).run(JSON.stringify([Number(factory.id)]), String(positionId));

  db.prepare(
    `INSERT INTO agent_persona(position_id, content, status, created_at, updated_at)
     VALUES (?, ?, 'enabled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(positionId, PERSONA);

  const insertOpening = db.prepare(
    `INSERT INTO position_opening(position_id, seq, kind, content, media_name, delay_ms, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 2000, 'enabled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  OPENINGS.forEach((item, index) => {
    insertOpening.run(positionId, index + 1, item.kind, item.content, item.media);
  });

  db.exec("COMMIT");

  console.log("城市 id:", Number(city.id));
  console.log("工厂 id:", Number(factory.id));
  console.log("岗位 id:", positionId);
  console.log("开场:", OPENINGS.length, "条");
  console.log("人设:", PERSONA.length, "字");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("失败已回滚:", error.message);
  process.exitCode = 1;
}
db.close();
