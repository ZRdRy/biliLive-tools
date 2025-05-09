import request from "./request";

/**
 * 查询直播记录列表
 * @param params 查询参数
 * @returns 查询结果
 */
export interface QueryRecordsParams {
  room_id: string;
  platform: string;
  page?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
}

export interface RecordHistoryItem {
  id: number;
  streamer_id: number;
  live_start_time: number;
  record_start_time: number;
  record_end_time?: number;
  title: string;
  video_file?: string;
  created_at: number;
}

export interface QueryRecordsResponse {
  code: number;
  data: RecordHistoryItem[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/**
 * 查询直播记录
 */
export async function queryRecords(params: QueryRecordsParams) {
  const res = await request.get("/record-history/list", {
    params,
  });
  return res.data;
}

export default {
  queryRecords,
};
