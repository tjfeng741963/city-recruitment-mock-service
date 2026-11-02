# 来源与许可声明（NOTICE）

本文件说明 `wecom_io` 的全部代码来源、开源许可证，以及责任划分。
**分发本项目前请连同本文件一起交付。**

---

## 一句话说明

> 本项目的技术实现**全部来自两个公开的开源仓库**（MIT 许可证），
> 作者没有发明任何破解手段，只是把「读」和「发」两部分拼在一起，加了一层图形界面。
>
> 程序**完全在本机运行**，不联网、不收集、不上传任何数据；
> 仓库里**不含**任何人的聊天记录、密钥、账号信息。
>
> 使用本项目产生的任何后果（账号被限制、数据合规、法律责任）**由使用者自行承担**。

---

## 一、上游开源仓库

| # | 仓库 | 地址 | 许可证 | 在本项目中的作用 |
| --- | --- | --- | --- | --- |
| 1 | **wecom-alert-suite** | https://github.com/99Gaoxiaoqi/wecom-alert-suite | MIT | 提供企业微信本地库的解密与密钥提取实现（`core/vendor/` 直接引入） |
| 2 | **wecom-reader**（经 #1 间接引入） | https://github.com/wangk-ask/wecom-reader | MIT | 上述解密引擎的原始出处，由 #1 以 vendored 方式打包 |
| 3 | **wecom-group-sender** | https://github.com/xiaoseisei/wecom-group-sender | MIT | 提供「Ctrl+F 搜索会话 → 回车 → 粘贴 → 回车」的发送动作序列与踩坑经验 |

三个仓库均为**公开开源项目**，许可证原文见 `LICENSES/` 目录：

```
LICENSES/
├── wecom-alert-suite-MIT.txt      Copyright (c) 2026 wecom-alert-suite contributors
├── wecom-reader-MIT.txt           Copyright (c) 2026 zhen.qian
└── wecom-group-sender-MIT.txt     Copyright (c) 2026 xiaoseisei
```

## 二、代码来源逐文件对照

| 本项目文件 | 来源 | 说明 |
| --- | --- | --- |
| `core/vendor/decrypt.py` | wecom-alert-suite<br>`skills/wecom-alert-reader/scripts/wecom_reader/crypto/decrypt.py` | **逐字节一致，未修改**（已用 `diff` 核对） |
| `core/vendor/key_extract.py` | wecom-alert-suite<br>`.../crypto/key_extract.py` | **逐字节一致，未修改**（已用 `diff` 核对） |
| `core/vendor/__init__.py` | 本项目 | 仅一行出处说明 |
| `core/crypto.py` | 改写自 `decrypt.py` | 算法相同（wxSQLite3 AES-128，`MD5(raw_key + LE32(页号) + "sAlT")`），按本项目结构重新组织 |
| `core/send.py` | 复刻 wecom-group-sender<br>`scripts/wecom_sender.py::_send_once` | **未复制代码**，按其九步动作序列重新实现 |
| `core/store.py` | 本项目 | 解密缓存、WAL 叠加、会话/消息查询 |
| `core/win.py` | 本项目 | 窗口定位与键鼠原语，做法参考 `wecom_control.py` |
| `app.py` / `main.py` | 本项目 | 图形界面与命令行 |

> 唯一与本项目相关的实质性改进：**WAL 叠加**（`store.py::_overlay_wal`）。
> 上游两个仓库都没有处理 `-wal` 文件，导致读不到最新消息；本项目补上了这一步。

## 三、开源许可证（MIT 全文）

以下为上述仓库共同使用的 MIT 许可证文本，各仓库的版权行见第一节：

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 四、责任与担保声明

1. **按「原样」提供**。本项目不提供任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保。
2. **不接入任何服务**。本项目不由任何公司运营，不连接企业微信服务器，不提供任何在线服务。
3. **不收集数据**。程序只读本机文件与进程内存，全部处理在本机完成；无网络请求、无遥测、无日志上报。
4. **不含他人数据**。仓库中不含聊天记录、密钥、账号信息；运行后产生的 `_decrypted/` 是使用者本机的临时产物，删除该目录即彻底清除。
5. **使用后果自负**。因使用本项目导致的账号被限制登录、数据丢失、合规争议、法律责任或任何直接/间接损失，**由使用者自行承担**。
6. **分发者不承担责任**。本项目的传播者、交付者、介绍者均不因他人使用本软件而产生任何义务或责任。
7. **不同意即停用**。若不同意以上任一条款，请立即删除本软件及其全部副本。

## 五、必须如实说明的三点（不省略）

免责声明在民法上属于「风险提示 + 责任约定」，能明确责任边界、降低争议，
但**不能免除法律强制规定的责任**。因此下面三点必须让使用者知道：

1. **发送功能违反平台协议**。键鼠模拟属于企业微信服务协议禁止的外挂行为，
   实测已触发三次处置（隐藏窗口+扫码、进程强退、退回登录页）。这是**平台层面的风险**，
   与代码质量无关，降低频率只能延后发现。
2. **解密功能属于绕过技术保护措施**。读取自己的数据通常不构成「侵入他人系统」，
   但可能违反服务条款；上游作者自己也写明「腾讯有向代码托管平台发 DMCA 下架同类工具的先例」。
3. **聊天内容含第三方个人信息**。导出、外传、上传他人聊天记录可能违反《个人信息保护法》。
   **不要把 `_decrypted/` 目录发给任何人**，也不要把导出的记录用于本机之外的用途。

## 六、如何彻底移除上游代码

如果只需要「读」或只需要「发」，可自行裁剪：

```bat
:: 完全不用解密功能（只保留发送）
删掉 core/store.py、core/crypto.py、core/vendor/

:: 完全不用发送功能（只保留读取）
删掉 core/send.py，以及 app.py 里的「发送」区域
```

裁剪后本项目不再包含任何上游代码，MIT 许可证的署名义务也随之消失。

---

*本文件随代码一起分发；修改代码时请同步更新第二节的对照表。*
