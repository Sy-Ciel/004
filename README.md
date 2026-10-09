# ComfyUI 角色配图 (Krea 2) — SillyTavern 扩展

正文 AI 回复完之后，用一个**额外的模型**读剧情，判断角色（默认是 {{user}}）此刻的状态，写出服装、动作、表情、神态、场景，
再和你**预先写好的固定外貌**（发型、面部等）拼成提示词，交给 ComfyUI 的 **Krea 2 文生图 + LoRA** 工作流出图，图片贴回这一楼。

- 只画**一个人**：{{user}}、当前角色、指定 NPC，或者让解析模型自动挑本楼的主角
- **预设绑定用户人设**：切换酒馆的用户人设（A → B）时，{{user}} 自动换成 B 绑定的预设
- 图片可以放在正文**上方 / 下方 / 左侧 / 右侧**（左右是电脑版布局，手机上自动改回上方或下方）
- **固定部分 + AI 部分**：发型 / 面部 / 体型 / 角色 LoRA 写死在角色预设里，AI 只负责会变化的部分
- **正文 AI 看不到**：图片和提示词存在消息的扩展数据里、单独渲染，不写进正文，不会进上下文，也不会作为图片发给多模态模型
- **自定义分辨率**、全局 LoRA + 角色 LoRA（留空自动旁路）
- **调试模式**：每层楼都能查看提示词、解析模型的输入输出、最终提交给 ComfyUI 的工作流

## 安装

1. 酒馆 → 扩展 → 安装扩展，填入本仓库地址：`https://github.com/sy-ciel/004`
2. 在 SillyTavern 1.19.0（release 分支）上测试通过；用到了 `SillyTavern.getContext()` 里的 `ChatCompletionService`、`ConnectionManagerRequestService`，太旧的版本可能缺这些接口
3. 设置面板在 扩展 → **ComfyUI 角色配图 (Krea 2)**

## ComfyUI 准备（Krea 2）

需要 ComfyUI **v0.26 或更新**（原生支持 Krea 2，不需要自定义节点）。模型从 [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2) 下载：

| 文件 | 放到 |
|---|---|
| `krea2_turbo_fp8_scaled.safetensors` | `ComfyUI/models/diffusion_models/` |
| `qwen3vl_4b_fp8_scaled.safetensors` | `ComfyUI/models/text_encoders/` |
| `qwen_image_vae.safetensors` | `ComfyUI/models/vae/` |
| 你的 LoRA | `ComfyUI/models/loras/` |

内置工作流（`workflows/krea2_turbo_t2i_lora_api.json`）和官方模板一致：

```
UNETLoader ─► 角色 LoRA ─► 全局 LoRA ─► KSampler (8 步 · CFG 1 · euler · simple) ─► VAEDecode ─► SaveImage
CLIPLoader (type = krea2) ─► CLIPTextEncode ─► ConditioningZeroOut (负向)
EmptyLatentImage (自定义宽高)
```

`workflows/krea2_turbo_t2i_lora_ui.json` 是同一个工作流的 UI 版，可以直接拖进 ComfyUI 检查模型是否齐全、手动试跑
（设置面板里也有下载链接）。

## 快速上手

1. **ComfyUI**：填地址（默认 `http://127.0.0.1:8188`），点「测试连接」。连接方式默认「酒馆后端代理」，不需要给 ComfyUI 开 CORS
2. **解析模型**（三选一）
   - 独立 API：任意 OpenAI 兼容接口（DeepSeek、智谱 GLM、OpenRouter、本地 LM Studio / Ollama 的 `/v1`……），填地址、Key，点「获取模型」后在下拉框里选模型。请求经酒馆后端转发。
     「附加请求参数」里的 JSON 会合并进请求体，例如 GLM 关闭思考：`{"thinking": {"type": "disabled"}}`
   - 酒馆连接配置：在酒馆的 Connection Manager 里建一个配置，这里选它
   - 酒馆当前 API：和正文共用
   - 填完点「测试解析模型」
3. **角色预设**：默认有一个 `{{user}}` 预设，把「固定外貌」改成你的角色（英文），需要的话选角色 LoRA、填触发词。
   要画 NPC 就新建预设，名字填 NPC 的名字，别名里写剧情中的其它称呼。
   有多个用户人设时，给每个人设建一个预设，在「绑定用户人设」里勾上对应的人设（见下方）
4. **目标角色**选 {{user}} / {{char}} / 自动 / 某个预设
5. 在 ComfyUI 区点「从 ComfyUI 读取列表」，然后在下拉框里选扩散模型、文本编码器、VAE、LoRA（列表里没有的可以选「✏️ 手动输入…」）
6. 正常聊天。AI 回复结束后会显示「正在解析角色状态… → ComfyUI 生成中…」，完成后图片出现在这一楼正文下方

自动配图只针对**刚生成完的最新一楼**；开场白（前面没有任何用户消息的楼层）默认不自动配图，可在「开场白也自动配图」打开。
已经有结果（图片、失败或跳过）的楼层不会被自动重复生成，需要时点 🔄 或消息菜单里的 🖼。

## 用户人设绑定

酒馆里切换用户人设时，{{user}} 用哪个预设按这个顺序决定：

1. 勾选了当前人设的预设（一个人设只能绑定一个预设，勾到别的预设上会自动改绑）
2. 没有绑定时，用**没有绑定任何人设**、且名字或别名和当前人设名相同的预设（例如名字写 `{{user}}` 的通用预设）
3. 都没有就不加固定外貌

目标选「{{user}}」或者直接选某个用户预设（绑定了人设或名字是 `{{user}}` 的预设）都会跟随切换。
切换人设时右上角会提示 {{user}} 现在用的是哪个预设，「目标角色」下拉框里也会显示。

## 图片位置

设置 → 基本 → 图片位置：正文下方 / 正文上方 / 正文左侧 / 正文右侧。

- 左右布局时图片宽度取「左右布局图片宽度(%)」和「图片最大宽度(px)」里较小的一个
- 「文字环绕图片」关闭时图片和正文是两栏；打开时正文排满图片旁边后从图片下方继续
- 窗口窄于 1000px（酒馆的手机布局）时自动改用「窄屏 / 手机上改为」选的上方或下方，拉宽窗口又会变回左右

## 每楼的操作

图片下方的小工具栏：

| 图标 | 作用 |
|---|---|
| ‹ 1/3 › | 在这一楼的多个版本之间切换 |
| 🎲 | 同一提示词换种子重画（不再调用解析模型） |
| 🔄 | 重新解析状态并生成 |
| ✏️ | 手动编辑提示词后生成 |
| 🐞 | 调试信息（调试模式下显示） |
| 🗑 | 删除当前这张图（同时删除服务器上的文件） |

消息的「…」菜单里多了一个 🖼 按钮，可以给任意一楼手动配图。魔杖菜单里有「ComfyUI 角色配图」，为最新楼层生成。

每个 swipe 有各自的图片，左右滑动会跟着切换；新 swipe 生成完会自动配图。

## 调试模式

打开「调试模式」后：

- 每张图下面多一行可展开的 **#楼层 提示词**
- 🐞 弹窗按「① 固定部分 / ② AI 解析部分 / ③ ComfyUI 参数」分段展示，包括解析模型的原始输出、
  完整输入（System + 剧情上下文）、最终提交的 API 工作流、LoRA 旁路等处理备注
- 设置面板里：
  - **查看各楼层提示词**：本聊天所有配了图的楼层一览，点「详情」进入单楼调试
  - **预览解析输入**：不发请求，只看会发给解析模型的内容
  - **试运行解析（不出图）**：调用解析模型并显示最终提示词，不调用 ComfyUI

> 解析模型的完整输入和工作流只在调试模式开启时记录（避免聊天文件变大）；最终提示词、解析结果和出图参数始终记录。

斜杠命令：

```
/ctimg                       为最新 AI 楼层生成
/ctimg at=12 target=莉娜      为 #12 楼画「莉娜」
/ctimg prompt="..."          跳过解析，直接用这段提示词
/ctimg-target auto           切换目标：预设名 / user / char / auto
/ctimg-debug on              开关调试模式
```

## 提示词是怎么拼的

解析模型返回 JSON：

```json
{"skip": false, "target": "...", "outfit": "...", "action": "...", "expression": "...",
 "demeanor": "...", "scene": "...", "camera": "...", "lighting": "..."}
```

然后套进「组装模板」（可在设置里改）：

```
{{trigger}} {{prefix}}
A solo image of a single person, only one person in the frame.
{{appearance}}
Wearing {{outfit}}.
{{action}}.
Facial expression: {{expression}}. {{demeanor}}.
Setting: {{scene}}.
{{camera}}, {{lighting}}.
{{suffix}}
```

某一行的变量全为空时整行省略。`{{appearance}}`、`{{trigger}}` 来自角色预设，`{{prefix}}` / `{{suffix}}` 是全局画风设置，其余来自解析模型。

开启「状态延续」时，解析模型会拿到同一角色上一张图的服装、场景等，剧情里没换装就保持一致。

## 使用自己的工作流

工作流选「自定义」，粘贴 ComfyUI **导出(API)** 得到的 JSON。可用占位符（整个字符串等于占位符时会替换成对应类型的值）：

```
%prompt% %negative_prompt% %width% %height% %seed% %steps% %cfg% %sampler% %scheduler%
%unet% %clip% %vae% %lora% %lora_strength% %char_lora% %char_lora_strength% %filename_prefix%
```

- `lora_name` 为空的 LoRA 节点会被自动旁路（上下游自动连上），所以没有 LoRA 时不用改工作流
- 如果工作流里没有 `%prompt%`，会自动顺着 KSampler 的 positive / negative 找到文本编码节点写入提示词，并写入种子和分辨率
- 「校验」按钮会检查格式、列出占位符和处理备注；UI 格式的工作流会被拒绝并提示改用 API 格式导出

## 正文 AI 为什么看不到

- 图片、提示词、解析结果都存在 `message.extra.comfy_portrait`（以及对应 swipe 的 `swipe_info[i].extra`）里，酒馆组装上下文时不会读取这个字段
- 不使用酒馆自带的 `extra.image` / `extra.media`，所以即使开了「发送图片」也不会把配图发给多模态模型
- 图片由扩展自己插入到消息 DOM 中，`mes` 正文一个字都不改
- 解析模型的请求是独立请求，不进聊天记录

## 常见问题

- **代理模式报错只有一句 “ComfyUI returned an error.”**：这是酒馆后端代理的限制。临时切到「浏览器直连」（ComfyUI 用 `--enable-cors-header` 启动）可以看到具体是哪个节点、什么错误
- **「从 ComfyUI 读取列表」只读到部分列表**：酒馆后端只提供扩散模型、VAE、采样器、调度器的列表，没有 LoRA 和文本编码器的接口；
  这两个列表要由浏览器直接访问 ComfyUI 的 `/object_info` 读取。做法：ComfyUI 加启动参数 `--listen --enable-cors-header`，
  在「浏览器直连地址」填浏览器所在设备能访问到的地址（用手机访问酒馆时填电脑的局域网 IP，如 `http://192.168.1.10:8188`，
  手机上的 `127.0.0.1` 指的是手机自己）。读不到也可以在下拉框里选「手动输入」。读到的列表会缓存，下次不用重新读
- **解析失败「返回了空内容」/「输出被截断」**：多半是思考模型把「最大输出」用在思考上了。调大「最大输出」（默认 2048），
  或在「附加请求参数」里关闭思考。🐞 调试弹窗里能看到结束原因（finish_reason）和思考内容
- **分辨率**：Krea 2 Turbo 适合约 1–2 MP，最高约 4 MP。设置里会显示当前像素数，超过 4 MP 会提示——过大容易画出重复的人物或多余肢体
- **解析模型偶尔输出跳过**：剧情里目标角色不在场时会跳过；调试模式下能看到跳过原因并「强制生成」。手动触发（按钮、斜杠命令）总是强制生成
- **API Key 存在哪**：存在酒馆的扩展设置（`settings.json`）里，请求时作为请求头经酒馆后端转发
