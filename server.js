// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < 4; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

function getBalancedRoles(count) {
  if (count <= 3) return ['mafia', 'police', 'doctor'];
  if (count <= 4) return ['mafia', 'police', 'doctor', 'citizen'];
  if (count <= 6) return ['mafia', 'mafia', 'police', 'doctor', 'citizen', 'citizen'];
  if (count <= 8) return ['mafia', 'mafia', 'police', 'doctor', 'soldier', 'citizen', 'citizen', 'citizen'];
  return ['mafia', 'mafia', 'traitor', 'police', 'doctor', 'soldier', 'citizen', 'citizen', 'citizen', 'citizen'];
}

// 타이머 인터벌 관리 함수
function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startPhaseTimer(room, durationSec, onEndCallback) {
  clearRoomTimer(room);
  room.remainingTime = durationSec;
  io.to(room.code).emit('timer_tick', { remainingTime: room.remainingTime });

  room.timerInterval = setInterval(() => {
    room.remainingTime--;
    io.to(room.code).emit('timer_tick', { remainingTime: room.remainingTime });

    if (room.remainingTime <= 0) {
      clearRoomTimer(room);
      onEndCallback();
    }
  }, 1000);
}

// 밤 페이즈 정산 및 아침 전환
function resolveNight(room) {
  clearRoomTimer(room);
  let killedPlayer = null;

  // 마피아 타깃이 있고 의사가 치료하지 못한 경우
  if (room.nightActions.mafiaTarget) {
    if (room.nightActions.mafiaTarget !== room.nightActions.doctorTarget) {
      killedPlayer = room.players.find(p => p.id === room.nightActions.mafiaTarget);
      if (killedPlayer) {
        killedPlayer.isDead = true;
      }
    }
  }

  // 승리 조건 체크
  const aliveMafia = room.players.filter(p => !p.isDead && p.role === 'mafia').length;
  const aliveCitizens = room.players.filter(p => !p.isDead && p.role !== 'mafia').length;

  let winner = null;
  if (aliveMafia === 0) winner = '시민 팀';
  else if (aliveMafia >= aliveCitizens) winner = '마피아 팀';

  // 아침 발표
  room.phase = 'DAY_TALK';
  room.dayCount++;
  // 귓속말 대상 초기화 (새로운 날)
  room.players.forEach(p => p.whisperedToday = []);

  io.to(room.code).emit('player_list_updated', room.players);
  io.to(room.code).emit('night_result', {
    killedName: killedPlayer ? killedPlayer.name : null,
    winner: winner,
    dayCount: room.dayCount
  });

  if (winner) return;

  // 다음 날 낮 자유 토론 시작
  startPhaseTimer(room, room.talkTime, () => {
    startVote1(room);
  });
}

function startVote1(room) {
  room.phase = 'DAY_VOTE1';
  room.votes1 = {};
  room.players.forEach(p => p.votes = 0);
  io.to(room.code).emit('player_list_updated', room.players);
  io.to(room.code).emit('phase_changed', { phase: 'DAY_VOTE1' });

  startPhaseTimer(room, 30, () => {
    tallyVote1(room);
  });
}

function tallyVote1(room) {
  clearRoomTimer(room);
  const counts = {};
  Object.values(room.votes1).forEach(tid => counts[tid] = (counts[tid] || 0) + 1);

  let maxVote = 0;
  let topTarget = null;
  let isTie = false;

  for (const [tid, cnt] of Object.entries(counts)) {
    if (cnt > maxVote) {
      maxVote = cnt;
      topTarget = tid;
      isTie = false;
    } else if (cnt === maxVote && maxVote > 0) {
      isTie = true;
    }
  }

  if (!topTarget || isTie || maxVote === 0) {
    // 동표 또는 무투표 시 처형 없이 바로 밤으로 전환
    io.to(room.code).emit('announcement', '투표 결과: 동표 또는 무투표로 아무도 지목되지 않았습니다. 밤으로 넘어갑니다.');
    enterNightPhase(room);
    return;
  }

  const suspect = room.players.find(p => p.id === topTarget);
  room.suspectId = topTarget;
  room.phase = 'TRIAL_DEFENSE';

  io.to(room.code).emit('phase_changed', {
    phase: 'TRIAL_DEFENSE',
    suspectName: suspect ? suspect.name : '알 수 없음'
  });

  // 해명 시간 (60초)
  startPhaseTimer(room, 60, () => {
    startFinalVote(room);
  });
}

function startFinalVote(room) {
  room.phase = 'TRIAL_FINAL';
  room.votesFinal = { execute: 0, spare: 0, votedSockets: [] };
  io.to(room.code).emit('phase_changed', { phase: 'TRIAL_FINAL' });

  startPhaseTimer(room, 20, () => {
    tallyFinalVote(room);
  });
}

function tallyFinalVote(room) {
  clearRoomTimer(room);
  const suspect = room.players.find(p => p.id === room.suspectId);
  if (room.votesFinal.execute > room.votesFinal.spare) {
    if (suspect) suspect.isDead = true;
    io.to(room.code).emit('announcement', `최종 투표 결과: 찬성 과반수로 [${suspect ? suspect.name : ''}]님이 처형되었습니다.`);
  } else {
    io.to(room.code).emit('announcement', `최종 투표 결과: 해명이 받아들여져 처형이 무산되었습니다.`);
  }

  io.to(room.code).emit('player_list_updated', room.players);
  enterNightPhase(room);
}

function enterNightPhase(room) {
  room.phase = 'NIGHT';
  room.nightActions = { mafiaTarget: null, doctorTarget: null, policeTarget: null };
  io.to(room.code).emit('phase_changed', { phase: 'NIGHT' });

  // 밤 제한 시간 (30초)
  startPhaseTimer(room, 30, () => {
    resolveNight(room);
  });
}

io.on('connection', (socket) => {
  // 방 만들기
  socket.on('create_room', ({ hostName, playerCount, talkTime }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) roomCode = generateRoomCode();

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      maxPlayers: playerCount || 6,
      talkTime: talkTime || 180,
      phase: 'LOBBY',
      dayCount: 1,
      players: [],
      votes1: {},
      votesFinal: { execute: 0, spare: 0, votedSockets: [] },
      suspectId: null,
      nightActions: { mafiaTarget: null, doctorTarget: null, policeTarget: null },
      timerInterval: null,
      remainingTime: 0
    };

    socket.join(roomCode);
    rooms[roomCode].players.push({
      id: socket.id,
      name: hostName,
      role: null,
      isDead: false,
      isHost: true,
      votes: 0,
      whisperedToday: []
    });

    socket.emit('room_created', { roomCode, maxPlayers: playerCount || 6 });
    io.to(roomCode).emit('player_list_updated', rooms[roomCode].players);
  });

  // 방 참가하기
  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', '존재하지 않는 방 코드입니다.');
    if (room.phase !== 'LOBBY') return socket.emit('error_msg', '이미 게임이 시작되었습니다.');
    if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '인원이 가득 찼습니다.');

    socket.join(roomCode);
    room.players.push({
      id: socket.id,
      name: playerName,
      role: null,
      isDead: false,
      isHost: false,
      votes: 0,
      whisperedToday: []
    });

    socket.emit('join_success', { roomCode, maxPlayers: room.maxPlayers });
    io.to(roomCode).emit('player_list_updated', room.players);
  });

  // 게임 시작
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;

    const roles = getBalancedRoles(room.players.length);
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    room.players.forEach((p, idx) => {
      p.role = roles[idx];
      io.to(p.id).emit('role_assigned', { role: p.role });
      if (p.role === 'mafia') {
        io.sockets.sockets.get(p.id)?.join(roomCode + '_mafia');
      }
    });

    room.phase = 'DAY_TALK';
    io.to(roomCode).emit('player_list_updated', room.players);
    io.to(roomCode).emit('phase_changed', { phase: 'DAY_TALK' });

    startPhaseTimer(room, room.talkTime, () => {
      startVote1(room);
    });
  });

  // 1차 투표 시작 트리거 (방장 조기 종료)
  socket.on('trigger_vote1', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    clearRoomTimer(room);
    startVote1(room);
  });

  // 1차 투표 행사
  socket.on('cast_vote1', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_VOTE1') return;

    room.votes1[socket.id] = targetId;

    const counts = {};
    Object.values(room.votes1).forEach(tid => counts[tid] = (counts[tid] || 0) + 1);
    room.players.forEach(p => p.votes = counts[p.id] || 0);
    io.to(roomCode).emit('player_list_updated', room.players);

    const aliveCount = room.players.filter(p => !p.isDead).length;
    if (Object.keys(room.votes1).length >= aliveCount) {
      tallyVote1(room);
    }
  });

  // 최종 찬반 투표 시작 (방장 조기 종료)
  socket.on('trigger_final_vote', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    clearRoomTimer(room);
    startFinalVote(room);
  });

  // 최종 찬반 투표 행사
  socket.on('cast_vote_final', ({ roomCode, isExecute }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'TRIAL_FINAL') return;
    if (room.votesFinal.votedSockets.includes(socket.id)) return;

    room.votesFinal.votedSockets.push(socket.id);
    if (isExecute) room.votesFinal.execute++;
    else room.votesFinal.spare++;

    const aliveCount = room.players.filter(p => !p.isDead).length;
    if (room.votesFinal.votedSockets.length >= aliveCount) {
      tallyFinalVote(room);
    }
  });

  // 밤 행동 제출 (마피아/의사/경찰)
  socket.on('night_action', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'NIGHT') return;

    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || sender.isDead) return;

    if (sender.role === 'mafia') {
      room.nightActions.mafiaTarget = targetId;
      // 마피아 룸에 선택 알림
      const target = room.players.find(p => p.id === targetId);
      io.to(roomCode + '_mafia').emit('mafia_target_updated', {
        targetName: target ? target.name : ''
      });
    } else if (sender.role === 'doctor') {
      room.nightActions.doctorTarget = targetId;
    } else if (sender.role === 'police') {
      room.nightActions.policeTarget = targetId;
      const target = room.players.find(p => p.id === targetId);
      socket.emit('police_investigation_result', {
        targetName: target ? target.name : '',
        isMafia: target ? target.role === 'mafia' : false
      });
    }
  });

  // 비밀 귓속말 (하루 최대 2명 제한)
  socket.on('send_whisper', ({ roomCode, targetId, message }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_TALK') {
      return socket.emit('error_msg', '귓속말은 낮 자유 토론 시간에만 보낼 수 있습니다.');
    }

    const sender = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);

    if (!sender || sender.isDead) return;
    if (!target || target.isDead) return socket.emit('error_msg', '대상이 사망했거나 올바르지 않습니다.');
    if (sender.id === target.id) return socket.emit('error_msg', '자신에게는 귓속말을 보낼 수 없습니다.');

    sender.whisperedToday = sender.whisperedToday || [];

    // 이미 오늘 귓속말을 보낸 대상이 아니고, 서로 다른 대상을 2명 초과했을 때 차단
    if (!sender.whisperedToday.includes(targetId)) {
      if (sender.whisperedToday.length >= 2) {
        return socket.emit('error_msg', '귓속말은 하루에 최대 2명에게만 보낼 수 있습니다.');
      }
      sender.whisperedToday.push(targetId);
    }

    // 대상자에게 비밀 전송
    io.to(target.id).emit('whisper_received', {
      senderName: sender.name,
      message: message
    });

    // 보낸 사람 본인에게 확인 전송
    socket.emit('whisper_sent_success', {
      targetName: target.name,
      message: message,
      remainingCount: 2 - sender.whisperedToday.length
    });
  });

  // 마피아 단톡방 채팅
  socket.on('mafia_chat', ({ roomCode, msg, senderName }) => {
    io.to(roomCode + '_mafia').emit('mafia_chat_received', { sender: senderName, text: msg });
  });

  // 퇴장 처리
  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(code).emit('player_list_updated', room.players);
        if (room.players.length === 0) {
          clearRoomTimer(room);
          delete rooms[code];
        }
        break;
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('마피아 실시간 서버 가동 완료: http://localhost:' + PORT);
});