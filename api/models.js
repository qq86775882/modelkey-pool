/**
 * GET /v1/models — 返回可用模型列表（OpenAI 兼容）
 */
import { getDefaultModel } from './lib/key-store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const models = ['deepseek-ai/DeepSeek-V4-Pro', 'ZhipuAI/GLM-5'];

  return res.status(200).json({
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: 1714867200,
      owned_by: id.split('/')[0] || 'modelscope',
    })),
  });
}
