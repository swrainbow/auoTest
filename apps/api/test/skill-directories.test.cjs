const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { PathsService } = require('../src/paths/paths.service');
const { SkillsService } = require('../src/skills/skills.service');

test('中文 Skill 目录支持创建、编辑、加载和记录已验证修复', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-names-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = new PathsService();
  paths.skillsRoot = directory;
  const skills = new SkillsService(paths);
  for (const name of ['地图准备', '地图-v2', 'task-config']) {
    const files = await skills.createSkill(name);
    assert.ok(files.some(file => file.path === name + '/SKILL.md'));
  }
  const file = '地图准备/SKILL.md';
  const original = await skills.read(file);
  const content = original.content + '\n先核对地图全名。\n';
  await skills.write(file, content, false);
  await assert.rejects(skills.createSkill('地图准备'), /已存在/);
  const target = 'http://localhost';
  const repair = await skills.recordVerifiedRepair('地图准备', target, 1, [{ order: 1 }]);
  const docs = await skills.loadSkillDocs('地图准备', target);
  assert.equal(docs.find(doc => doc.path === file)?.content, content);
  assert.ok(docs.some(doc => doc.path === repair));
  for (const invalid of ['地图/准备', '../地图', '-地图', '地图--准备']) {
    await assert.rejects(skills.createSkill(invalid), /目录名/);
  }
});
