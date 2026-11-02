-- Généré par scripts/gen-test-sql.py, ne pas modifier à la main.

CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'USER',
  "avatar" TEXT NOT NULL DEFAULT '{}',
  "activeSubjectId" TEXT,
  "bannedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE TABLE "Subject" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "accessName" TEXT NOT NULL,
  "accessPasswordHash" TEXT NOT NULL,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Subject_name_key" ON "Subject"("name");
CREATE UNIQUE INDEX "Subject_accessName_key" ON "Subject"("accessName");
CREATE TABLE "SubjectManager" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SubjectManager_userId_subjectId_key" ON "SubjectManager"("userId", "subjectId");
CREATE INDEX "SubjectManager_subjectId_idx" ON "SubjectManager"("subjectId");
CREATE TABLE "Membership" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "xp" INTEGER NOT NULL DEFAULT 0,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "Membership_userId_subjectId_key" ON "Membership"("userId", "subjectId");
CREATE INDEX "Membership_subjectId_xp_idx" ON "Membership"("subjectId", "xp");
CREATE TABLE "Chapter" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subjectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "color" TEXT NOT NULL DEFAULT '',
  "locked" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "Chapter_subjectId_name_key" ON "Chapter"("subjectId", "name");
CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chapterId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "questionCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3)
);
CREATE TABLE "Question" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chapterId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "choices" TEXT NOT NULL,
  "answerIndex" INTEGER NOT NULL,
  "explanation" TEXT,
  "hash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3)
);
CREATE INDEX "Question_chapterId_hash_idx" ON "Question"("chapterId", "hash");
CREATE INDEX "Question_chapterId_createdAt_idx" ON "Question"("chapterId", "createdAt");
CREATE INDEX "Question_batchId_idx" ON "Question"("batchId");
CREATE TABLE "Game" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subjectId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "config" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3)
);
CREATE INDEX "Game_subjectId_createdAt_idx" ON "Game"("subjectId", "createdAt");
CREATE TABLE "GamePlayer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "correctCount" INTEGER NOT NULL DEFAULT 0,
  "result" TEXT,
  "xpEarned" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "GamePlayer_gameId_userId_key" ON "GamePlayer"("gameId", "userId");
CREATE INDEX "GamePlayer_userId_gameId_idx" ON "GamePlayer"("userId", "gameId");
CREATE TABLE "Round" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "chapterId" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Round_gameId_number_key" ON "Round"("gameId", "number");
CREATE TABLE "GameQuestion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "questionId" TEXT NOT NULL,
  "servedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "GameQuestion_roundId_position_key" ON "GameQuestion"("roundId", "position");
CREATE TABLE "Answer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameQuestionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "choiceIndex" INTEGER,
  "isCorrect" BOOLEAN NOT NULL,
  "timeMs" INTEGER,
  "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Answer_gameQuestionId_userId_key" ON "Answer"("gameQuestionId", "userId");
CREATE INDEX "Answer_userId_isCorrect_idx" ON "Answer"("userId", "isCorrect");
CREATE TABLE "XpEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "gameId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "XpEvent_subjectId_createdAt_idx" ON "XpEvent"("subjectId", "createdAt");
CREATE INDEX "XpEvent_userId_subjectId_createdAt_idx" ON "XpEvent"("userId", "subjectId", "createdAt");
CREATE TABLE "Tier" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subjectId" TEXT,
  "name" TEXT NOT NULL,
  "minLevel" INTEGER NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#9CA3AF'
);
CREATE INDEX "Tier_subjectId_minLevel_idx" ON "Tier"("subjectId", "minLevel");
CREATE TABLE "Badge" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "conditionType" TEXT NOT NULL,
  "threshold" INTEGER NOT NULL,
  "icon" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX "Badge_code_key" ON "Badge"("code");
CREATE TABLE "UserBadge" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "badgeId" TEXT NOT NULL,
  "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "UserBadge_userId_badgeId_key" ON "UserBadge"("userId", "badgeId");
CREATE TABLE "AvatarItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "category" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "assetPath" TEXT NOT NULL,
  "unlockType" TEXT NOT NULL DEFAULT 'FREE',
  "unlockValue" TEXT
);
CREATE TABLE "Setting" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL
);
CREATE TABLE "AdminLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "adminId" TEXT NOT NULL,
  "subjectId" TEXT,
  "action" TEXT NOT NULL,
  "details" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AdminLog_createdAt_idx" ON "AdminLog"("createdAt");
CREATE INDEX "AdminLog_subjectId_createdAt_idx" ON "AdminLog"("subjectId", "createdAt");
CREATE TABLE "QuestionServe" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameQuestionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "QuestionServe_gameQuestionId_userId_key" ON "QuestionServe"("gameQuestionId", "userId");
CREATE TABLE "Friendship" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subjectId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "Friendship_subjectId_requesterId_addresseeId_key" ON "Friendship"("subjectId", "requesterId", "addresseeId");
CREATE INDEX "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status");
CREATE INDEX "Friendship_requesterId_status_idx" ON "Friendship"("requesterId", "status");
CREATE TABLE "Message" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "friendshipId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3)
);
CREATE INDEX "Message_friendshipId_createdAt_idx" ON "Message"("friendshipId", "createdAt");
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
