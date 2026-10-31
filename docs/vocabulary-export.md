# 生词本导出

进入 **设置 → 生词本 → 导出**，选择格式和范围，再点击“导出 N 个单词”并选择保存位置。

- **全部生词**包含完整生词本，不受列表分页影响。
- **当前搜索结果**导出与搜索条件匹配的全部词条，不仅是当前屏幕上的词条。
- 导出不删除生词，也不改变本机复习进度。取消保存不会创建文件。

| 格式 | 适用方式 | 保留的内容 |
| --- | --- | --- |
| Anki `.apkg` | 在 Anki 中导入文件，或用支持此格式的 Anki 客户端打开 | 单词、音标、释义、原句；卡片正面为单词，背面为其余内容 |
| Anki `.tsv` | 在 Anki 中导入文本，选择“基础”笔记类型；第一列对应正面、第二列对应背面 | 同上，以 HTML 换行保留多行内容 |
| 欧路 / 通用 `.txt` | 欧路网页版生词本导入，或支持文本选词、自定义词书的应用 | 每行一个单词；释义由目标应用匹配 |
| Quizlet `.txt` | 在网页版创建学习集 → 导入，粘贴文件内容；术语和释义间选择制表符，卡片间选择换行 | 术语为单词，释义列合并音标、释义和原句 |
| 通用 `.csv` | 表格编辑，或在支持 CSV 的应用中自行映射列 | `Word`、`Phonetics`、`Meaning`、`Context` 四列 |

Anki 牌组可以自定义名称，也支持 `父牌组::子牌组`。导入后作为新卡片开始学习，不复制本软件的复习历史。相同单词使用稳定标识，重复导入同一牌组不会产生重复卡片；较新的释义可按 Anki 导入选项更新。

TXT 适合只需要词表的应用；如果希望保留自己收藏时的释义和原句，优先选择 APKG、TSV 或 CSV。不同背词软件允许的导入入口、账号功能及可识别词条不同，一行一词的 TXT 可用于其支持的文本导入或粘贴选词入口，不代表所有软件都能直接读取任意 CSV。

文件均使用 UTF-8。CSV 带 UTF-8 BOM，正确引用逗号、引号和多行字段；可能被表格识别为公式的文本按文本处理。导出仅在本机生成文件，不会自动上传到第三方账号。单次内容过大时，可搜索筛选后分批导出。

参考：[Anki 牌组导入](https://docs.ankiweb.net/importing/packaged-decks.html)、[Anki 文本导入](https://docs.ankiweb.net/importing/text-files.html)、[Quizlet 导入说明](https://help.quizlet.com/hc/en-us/articles/360029977151-Creating-sets-by-importing-content)、[欧路生词本导入入口](https://my.eudic.net/studylist/import)、[墨墨云词本](https://memodocs.maimemo.com/docs/QKUlwb6qTiLtzvk49BGc1ZVFnqg)。
