/**
 * GET /v1/models — 返回可用模型列表（OpenAI 兼容）
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const model = process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro';
  const ownedBy = model.split('/')[0] || 'modelscope';

  return res.status(200).json({
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: 1714867200,
        owned_by: ownedBy,
      },
    ],
  });
}
