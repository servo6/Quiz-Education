import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, joinSubject, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

const newOrg = async (name: string) => (await call(env, admin, "POST", "/api/organizations", { name })).json().organization.id as string;
const newSubject = async (organizationId: string, name: string) => (await call(env, admin, "POST", "/api/subjects", { name, organizationId })).json().subject.id as string;
const questions = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ question: `Question numéro ${i + 1} ?`, choices: ["A", "B", "C"], answer: 0, explanation: "Parce que." })));
async function seedContent(subjectId: string, chapter: string, n: number) {
  const r = await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: questions(n), newChapterName: chapter });
  assert.equal(r.statusCode, 201, r.body);
}

test("super testeur : créé par le super admin, inscrit partout, un avatar par organisation", async () => {
  const [o1, o2] = [await newOrg("Orga T1"), await newOrg("Orga T2")];
  const [s1, s2] = [await newSubject(o1, "Maths T"), await newSubject(o2, "Physique T")];
  const user = await register(env, "simple-user");
  assert.equal((await call(env, user.cookie, "POST", "/api/testers", { username: "tester-x", password: "password-123" })).statusCode, 403);
  assert.equal((await call(env, admin, "POST", "/api/testers", { username: "tester-x", password: "password-123" })).statusCode, 201);
  assert.equal((await call(env, admin, "POST", "/api/testers", { username: "tester-x", password: "password-123" })).statusCode, 409);
  const t = await login(env, "tester-x", "password-123");
  assert.equal((await call(env, user.cookie, "GET", "/api/tester/subjects")).statusCode, 403);

  assert.equal((await call(env, t, "POST", "/api/tester/join", { subjectId: s1 })).statusCode, 200);
  assert.equal((await call(env, t, "POST", "/api/tester/join", { subjectId: s2 })).statusCode, 200);
  const me = (await call(env, t, "GET", "/api/me")).json();
  assert.equal(me.user.tester, true);
  assert.equal(me.organizations.length, 2);
  assert.equal(me.subjects.length, 2);
  const list = (await call(env, t, "GET", "/api/tester/subjects")).json().organizations;
  assert.ok(list.flatMap((o: { subjects: { joined: boolean }[] }) => o.subjects).filter((s: { joined: boolean }) => s.joined).length >= 2);

  // Avatar propre à chaque organisation
  const row = await env.prisma.user.findFirstOrThrow({ where: { username: "tester-x" } });
  await call(env, t, "POST", "/api/me/active-subject", { subjectId: s1 });
  await env.prisma.user.update({ where: { id: row.id }, data: { avatar: JSON.stringify({ items: {}, colors: { skin: "#112233" }, look: {} }) } });
  await call(env, t, "POST", "/api/me/active-subject", { subjectId: s2 });
  assert.deepEqual((await call(env, t, "GET", "/api/me")).json().user.avatar.colors, {}); // profil vierge dans l'autre organisation
  await env.prisma.user.update({ where: { id: row.id }, data: { avatar: JSON.stringify({ items: {}, colors: { skin: "#aabbcc" }, look: {} }) } });
  await call(env, t, "POST", "/api/me/active-subject", { subjectId: s1 });
  assert.equal((await call(env, t, "GET", "/api/me")).json().user.avatar.colors.skin, "#112233");
  await call(env, t, "POST", "/api/me/active-subject", { subjectId: s2 });
  assert.equal((await call(env, t, "GET", "/api/me")).json().user.avatar.colors.skin, "#aabbcc");

  // Un joueur ordinaire reste limité à une organisation
  await joinSubject(env, user.cookie, s1);
  assert.equal((await joinSubject(env, user.cookie, s2)).statusCode, 409);
});

test("copier une matière : chapitres, questions, titres ; pas les joueurs", async () => {
  const [o1, o2] = [await newOrg("Orga C1"), await newOrg("Orga C2")];
  const src = await newSubject(o1, "Chimie C");
  await seedContent(src, "Atomes", 7);
  await seedContent(src, "Liaisons", 3);
  const p = await register(env, "joueur-copie");
  await joinSubject(env, p.cookie, src);

  const user = await register(env, "pas-admin");
  assert.equal((await call(env, user.cookie, "POST", `/api/subjects/${src}/copy`, { organizationId: o2 })).statusCode, 403);
  // copie dans la même organisation : permise, avec un autre nom
  const same = await call(env, admin, "POST", `/api/subjects/${src}/copy`, { organizationId: o1 });
  assert.equal(same.statusCode, 201);
  assert.equal(same.json().subject.name, "Chimie C (copie)");
  const res = await call(env, admin, "POST", `/api/subjects/${src}/copy`, { organizationId: o2 });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().chapters, 2);
  assert.equal(res.json().questions, 10);
  const copyId = res.json().subject.id as string;
  assert.equal(await env.prisma.membership.count({ where: { subjectId: copyId } }), 0);
  assert.equal(await env.prisma.question.count({ where: { chapter: { subjectId: copyId }, deletedAt: null } }), 10);
  // la source est intacte et un second exemplaire reçoit un autre nom
  assert.equal(await env.prisma.question.count({ where: { chapter: { subjectId: src }, deletedAt: null } }), 10);
  const again = await call(env, admin, "POST", `/api/subjects/${src}/copy`, { organizationId: o2 });
  assert.notEqual(again.json().subject.name, res.json().subject.name);
  assert.equal((await call(env, admin, "POST", `/api/subjects/${src}/copy`, { organizationId: o2, name: res.json().subject.name })).statusCode, 409);
});

test("déplacer une matière : les joueurs qui n'ont qu'elle suivent, les autres sont signalés", async () => {
  const [o1, o2] = [await newOrg("Orga M1"), await newOrg("Orga M2")];
  const [a, b] = [await newSubject(o1, "Alpha M"), await newSubject(o1, "Beta M")];
  await seedContent(a, "Chap", 4);
  const solo = await register(env, "joueur-seul");
  const double = await register(env, "joueur-double");
  await joinSubject(env, solo.cookie, a);
  await joinSubject(env, double.cookie, a);
  await joinSubject(env, double.cookie, b);

  const user = await register(env, "pas-admin-2");
  assert.equal((await call(env, user.cookie, "POST", `/api/subjects/${a}/move`, { organizationId: o2 })).statusCode, 403);
  const refuse = await call(env, admin, "POST", `/api/subjects/${a}/move`, { organizationId: o2 });
  assert.equal(refuse.statusCode, 409);
  assert.equal(refuse.json().error.code, "players_conflict");
  assert.equal((await env.prisma.subject.findUniqueOrThrow({ where: { id: a } })).organizationId, o1);

  const ok = await call(env, admin, "POST", `/api/subjects/${a}/move`, { organizationId: o2, force: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().players, ok.json().unenrolled], [1, 1]);
  assert.equal((await env.prisma.subject.findUniqueOrThrow({ where: { id: a } })).organizationId, o2);
  assert.equal(await env.prisma.question.count({ where: { chapter: { subjectId: a } } }), 4);
  const soloOrgs = await env.prisma.orgMember.findMany({ where: { userId: solo.id } });
  assert.deepEqual(soloOrgs.map((o) => o.organizationId), [o2]);
  assert.equal(await env.prisma.membership.count({ where: { userId: solo.id, subjectId: a } }), 1);
  assert.equal(await env.prisma.membership.count({ where: { userId: double.id, subjectId: a } }), 0);
  assert.equal(await env.prisma.membership.count({ where: { userId: double.id, subjectId: b } }), 1);
  // nom déjà pris à destination
  const c = await newSubject(o1, "Beta M2");
  await env.prisma.subject.update({ where: { id: c }, data: { name: "Alpha M" } });
  assert.equal((await call(env, admin, "POST", `/api/subjects/${c}/move`, { organizationId: o2 })).statusCode, 409);
});
