import { describe, expect, it } from "vitest";
import { openingLocationOptions } from "../frontend-vue/src/components/basic/opening-location-options.js";
import { serializeServicePosition } from "../src/shared/response-serializers.js";
import { normalizePositionFacts } from "../src/shared/position-facts.js";

describe("开场位置卡的岗位地点", () => {
  it("保留旧格式面试点，并带出默认地址和门店各自的坐标", () => {
    const options = openingLocationOptions({
      interview_points: ["东门集合点", { name: "南门", address: "南路1号", lng: 113.2, lat: 23.2 }],
      address: "北路2号", coordinates: "23.1,113.1",
      store_name: "西门店", store_address: "西路3号", store_coordinates: "23.3，113.3",
    });
    expect(options).toEqual([
      { name: "东门集合点", address: "", lng: "", lat: "" },
      { name: "南门", address: "南路1号", lng: 113.2, lat: 23.2 },
      { name: "默认面试地点", address: "北路2号", lng: 113.1, lat: 23.1 },
      { name: "西门店", address: "西路3号", lng: 113.3, lat: 23.3 },
    ]);
  });

  it("保留有地址无坐标的地点，也不把歧义坐标套到不同的面试地址", () => {
    expect(openingLocationOptions({
      work_address: "工作地点", interview_address: "面试地点", address: "面试地点", coordinates: "23,113",
      store_address: "门店地址", store_coordinates: "113,23",
    })).toEqual([
      { name: "默认面试地点", address: "面试地点", lng: "", lat: "" },
      { name: "门店", address: "门店地址", lng: "", lat: "" },
    ]);
  });

  it("面试地址已明确留空时，不把工作地址当面试地点", () => {
    expect(openingLocationOptions({ work_address: "工作地点", interview_address: "", address: "工作地点" })).toEqual([]);
  });

  it("保留旧事实卡的专用面试地址，忽略从工作地点推导出的地址", () => {
    const facts = { job_title: "安保", place: "岗位工作地点", coordinates: "23,113" };
    const saved = serializeServicePosition({ id: 1, data_json: JSON.stringify({ ...facts, interview_address: "岗位面试地点" }) });
    expect(openingLocationOptions(saved)).toEqual([
      { name: "默认面试地点", address: "岗位面试地点", lng: "", lat: "" },
    ]);
    expect(openingLocationOptions(serializeServicePosition({ id: 1, data_json: JSON.stringify(facts) }))).toEqual([]);
  });

  it("保存门店资料时保留已有的专用面试地址", () => {
    expect(normalizePositionFacts({ store_address: "门店", interview_address: "另一个面试地点" })).toMatchObject({
      place: "门店", interview_address: "另一个面试地点",
    });
  });
});
