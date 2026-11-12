// 测试环境全局开关：vitest 每个 worker 启动前都会执行本文件。
// 打开夹具数据注入（测试夹具行），供列表/权限类测试使用；
// 生产环境不设置该变量，seed 不会写入任何演示数据。
process.env.REA_SEED_FIXTURES = "1";
