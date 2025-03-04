import { readFileSync } from "fs";
import { load } from "js-yaml";
import axios from "axios";
import moment from "moment-timezone";

// 时区设置
const SHANGHAI_TZ = "Asia/Shanghai";
const { tz } = moment;

// 日志函数
function log(message, level = "info") {
  const timestamp = tz(SHANGHAI_TZ).format("YYYY-MM-DD HH:mm:ss");
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

/**
 * 判断当前时间是否在指定的开始时间和结束时间之间。
 * 支持跨天时间段（如 23:00 到 06:00）。
 */
function isTimeBetween(startTimeStr, endTimeStr) {
  const currentTime = tz(SHANGHAI_TZ);
  const startTime = tz(startTimeStr, "HH:mm:ss", SHANGHAI_TZ);
  const endTime = tz(endTimeStr, "HH:mm:ss", SHANGHAI_TZ);

  if (startTime.isAfter(endTime)) {
    return (
      currentTime.isSameOrAfter(startTime) ||
      currentTime.isSameOrBefore(endTime)
    );
  }
  return (
    currentTime.isSameOrAfter(startTime) && currentTime.isSameOrBefore(endTime)
  );
}

class XBClient {
  /**
   * xboard API 客户端，用于登录、获取节点和修改节点倍率。
   */
  constructor(host, adminPath, adminAccount, adminPassword) {
    this.host = host;
    this.adminPath = adminPath;
    this.adminAccount = adminAccount;
    this.adminPassword = adminPassword;
    this.authData = null;
    this.headers = {
      Host: this.host,
      Connection: "keep-alive",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "sec-ch-ua":
        '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      authorization: "",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "sec-ch-ua-platform": '"Windows"',
      Accept: "*/*",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Accept-Encoding": "utf-8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
  }

  /**
   * 登录 xboard 并获取授权数据。
   */
  async login() {
    const api = `https://${this.host}/api/v2/passport/auth/login`;
    const data = {
      email: this.adminAccount,
      password: this.adminPassword,
    };
    try {
      const response = await axios.post(api, data, { timeout: 10000 });
      const authData = response.data.data;
      if (authData.is_admin !== 1) {
        throw new Error("配置文件中的 xboard 账户不是管理员");
      }
      this.authData = authData.auth_data;
      log("登录成功");
    } catch (error) {
      log(`登录失败: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * 获取所有节点数据。
   */
  async getNodes() {
    if (!this.authData) {
      throw new Error("未授权，请先登录");
    }
    const api = `https://${this.host}/api/v2/${this.adminPath}/server/manage/getNodes`;
    this.headers.authorization = this.authData;
    try {
      const response = await axios.get(api, {
        headers: this.headers,
        timeout: 10000,
      });
      log("成功获取节点数据");
      return response.data.data;
    } catch (error) {
      log(`获取节点数据失败: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * 批量修改节点倍率。
   */
  async batchChange(updateNodesData) {
    if (!this.authData) {
      throw new Error("未授权，请先登录");
    }
    this.headers.authorization = this.authData;
    for (const nodeData of updateNodesData) {
      const postData = { ...nodeData };
      if (nodeData.group_id) {
        postData.group_id = nodeData.group_id.map((id, index) => [
          `group_id[${index}]`,
          id,
        ]);
      }
      if (!postData.type) {
        throw new Error(`修改节点 ID ${postData.id} 时缺少节点类型数据`);
      }
      const api = `https://${this.host}/api/v2/${this.adminPath}/server/manage/save`;
      try {
        await axios.post(api, postData, { headers: this.headers, timeout: 10000 });
        log(`修改 ${postData.type} 节点 ${postData.id} 为 ${postData.rate} 倍率成功`);
      } catch (error) {
        log(`修改 ${postData.type} 节点 ${postData.id} 倍率失败: ${error.message}`, "error");
      }
    }
  }
}

class DynamicRate {
  /**
   * 动态倍率调整类，负责加载配置并执行倍率调整。
   */
  constructor() {
    this.config = this.loadConfig();
    this.xbClient = new XBClient(
      this.config.host,
      this.config.admin_path,
      this.config.admin_account,
      this.config.admin_password
    );
  }

  /**
   * 加载配置文件并验证必要字段。
   */
  loadConfig() {
    try {
      const config = load(readFileSync("config.yaml", "utf8"));
      const requiredKeys = [
        "host",
        "admin_path",
        "admin_account",
        "admin_password",
        "nodes",
      ];
      for (const key of requiredKeys) {
        if (!config[key]) {
          throw new Error(`config.yaml 中缺少必要的键: ${key}`);
        }
      }
      return config;
    } catch (error) {
      log(`加载配置文件失败: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * 根据配置动态调整节点倍率。
   */
  async changeRate() {
    try {
      await this.xbClient.login();
      const existNodes = await this.xbClient.getNodes();
      const updateNodesData = [];
      for (const configNode of this.config.nodes) {
        for (const existNode of existNodes) {
          if (
            existNode.id === configNode.id &&
            existNode.type === configNode.type
          ) {
            for (const rateConfig of configNode.rate_config) {
              if (isTimeBetween(rateConfig.start_time, rateConfig.end_time)) {
                const temp = { ...existNode, rate: rateConfig.rate };
                updateNodesData.push(temp);
              }
            }
          }
        }
      }
      if (updateNodesData.length > 0) {
        await this.xbClient.batchChange(updateNodesData);
      } else {
        log("没有需要更新的节点");
      }
    } catch (error) {
      log(`调整倍率失败: ${error.message}`, "error");
    }
  }
}

// 主程序入口
(async () => {
  try {
    const dmRate = new DynamicRate();
    await dmRate.changeRate();
  } catch (error) {
    log(`脚本运行失败: ${error.message}`, "error");
  }
})();
