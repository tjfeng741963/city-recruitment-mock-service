import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { resolveInterviewLocation } from "../src/shared/interview-location.js";
import { locationPointOptions } from "../frontend-vue/src/components/agent/favorite-location-preview.js";

const card = { name: "面试点", address: "广州市车陂路测试地址", lng: 113.39114, lat: 23.117692 };

describe("岗位面试点是位置卡的唯一来源", () => {
  it("没有收藏名也可选，有缺项及重名的点显示原因而不是消失", () => {
    const options = locationPointOptions([card, {name:"缺坐标",address:"地址"}, {name:"缺地址",lng:113,lat:23}, {name:"同名"}, {name:"同名",favorite_title:"收藏"}]);
    expect(options[0]).toMatchObject({name:card.name,disabled:false});
    expect(options.slice(1).map(p=>p.reason)).toEqual(["缺有效坐标","缺详细地址","面试点名称重复","面试点名称重复"]);
  });
  it.each([null, "", true, NaN, Infinity, 0, 181, -181])("拒绝无效经度 %s，前后端口径一致", lng => {
    const point = {...card,lng};
    expect(resolveInterviewLocation([point],card.name)).toBeNull();
    expect(locationPointOptions([point])[0].disabled).toBe(true);
  });
  it.each([91,-91,0,null,true])("拒绝无效纬度 %s", lat => {
    expect(resolveInterviewLocation([{...card,lat}],card.name)).toBeNull();
  });
  it("不使用其他点、不按收藏名猜测、不自动纠正重名", () => {
    expect(resolveInterviewLocation([card],"收藏名")).toBeNull();
    expect(resolveInterviewLocation([card,card],card.name)).toBeNull();
    expect(resolveInterviewLocation([card,{name:"缺坐标"}],"缺坐标")).toBeNull();
  });
});

describe("完整地点步骤的保存与设备下发", () => {
  let app: ReturnType<typeof buildServer>;
  let admin: Record<string,string>, device: Record<string,string>, id: number;
  const graph = () => ({position_id:id,status:"enabled",entry_key:"intro",nodes:[{node_key:"intro",node_type:"text",parts:[
    {kind:"text",body:"先看面试地址。",delay_ms:0},
    {kind:"favorite_location",interview_point:card.name,delay_before_ms:3500,delay_ms:2000,location:{...card,lng:1}},
    {kind:"text",body:"到达后请联系。",delay_ms:0},
  ]}],edges:[{from_key:"intro",to_key:"",trigger:"default"}]});
  beforeAll(async()=>{
    const prior=process.env.REA_DATABASE_PATH; process.env.REA_DATABASE_PATH=":memory:";
    try {app=buildServer();} finally {if(prior===undefined)delete process.env.REA_DATABASE_PATH;else process.env.REA_DATABASE_PATH=prior;}
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"local-admin",password:"local-demo-only"}});
    admin={authorization:`Bearer ${login.json().access_token}`};
    const city=await app.inject({method:"POST",url:"/api/v1/cities",headers:admin,payload:{city_name:"定位测试城"}});
    const position=await app.inject({method:"POST",url:"/api/v1/service-positions",headers:admin,payload:{city_id:city.json().id,position_name:"位置卡岗位",interview_points:[card]}});
    id=position.json().id;
    const pair=await app.inject({method:"POST",url:"/api/v1/bridge/devices/local-device-001/pair",headers:admin});
    device={authorization:`Bearer ${pair.json().device_token}`};
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.position_id',?,'$.agent_position_id',?) WHERE json_extract(data_json,'$.device_code')='local-device-001'").run(id,id);
  });
  afterAll(async()=>{await app?.close();});
  it("无需收藏，忽略传入的伪造坐标，完整保留三步和间隔",async()=>{
    const saved=await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:graph()});
    expect(saved.statusCode,saved.body).toBe(200);
    expect(saved.json().nodes[0].parts[1].location).toEqual(card);
    const response=await app.inject({url:"/api/v1/agent/flow?device_code=local-device-001&location_links=1",headers:device});
    expect(response.json().blocked).toBeUndefined();
    expect(response.json().nodes[0].parts.map((p: {kind:string})=>p.kind)).toEqual(["text","favorite_location","text"]);
    expect(response.json().nodes[0].parts[1]).toMatchObject({
      body:`${card.name}：${card.address}\n导航：https://uri.amap.com/marker?position=${card.lng},${card.lat}`,
      delay_before_ms:3500,delay_ms:2000,
    });
    expect(response.json().nodes[0].parts[1]).not.toHaveProperty("location");
  });
  it("修改岗位坐标不会修改已保存流程，重新保存才采用新地点",async()=>{
    await app.inject({method:"PUT",url:`/api/v1/service-positions/${id}`,headers:admin,payload:{interview_points:[{...card,lng:114}]}});
    let flow=await app.inject({url:"/api/v1/agent/flow?device_code=local-device-001&location_links=1",headers:device});
    expect(flow.json().nodes[0].parts[1].body).toContain(`position=${card.lng},${card.lat}`);
    await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:graph()});
    flow=await app.inject({url:"/api/v1/agent/flow?device_code=local-device-001&location_links=1",headers:device});
    expect(flow.json().nodes[0].parts[1].body).toContain(`position=114,${card.lat}`);
  });
  it("原生卡客户端继续执行普通消息，已启用导航但快照缺失时新版不发送",async()=>{
    const old=await app.inject({url:"/api/v1/agent/flow?device_code=local-device-001&location_steps=1",headers:device});
    expect(old.json().nodes[0].parts.map((p: {kind:string})=>p.kind)).toEqual(["text","text"]);
    app.db.prepare("UPDATE agent_flow_node SET parts_json=json_remove(parts_json,'$[1].location')").run();
    const missing=await app.inject({url:"/api/v1/agent/flow?device_code=local-device-001&location_links=1",headers:device});
    expect(missing.json().nodes[0].parts[1]).toMatchObject({kind:"favorite_location",body:""});
  });
  it("引用另一岗位点或缺坐标的点，保存失败",async()=>{
    const graphOther=graph(); graphOther.nodes[0].parts[1].interview_point="另一岗位的点";
    expect((await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:graphOther})).statusCode).toBe(422);
    await app.inject({method:"PUT",url:`/api/v1/service-positions/${id}`,headers:admin,payload:{interview_points:[{name:card.name,address:card.address,favorite_title:"有收藏也没用"}]}});
    expect((await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:graph()})).statusCode).toBe(422);
  });
});
