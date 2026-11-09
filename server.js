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

const AVATARS = ['🐶','🐱','🦊','🐻','🐰','🐼','🦁','🐯','🐸','🐵','🦄','🦉','🐙','🦖','👽'];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < 4; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

function clearRoomTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  if (room.goldenBellTimeout) { clearTimeout(room.goldenBellTimeout); room.goldenBellTimeout = null; }
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
      if (onEndCallback) onEndCallback();
    }
  }, 1000);
}

function checkWinCondition(room) {
  const alive = room.players.filter(p => !p.isDead);
  const mafiaKillers = alive.filter(p => p.role === 'mafia').length; 
  const mafiaTeam = alive.filter(p => ['mafia', 'spy', 'madam'].includes(p.role)).length;
  const citizenTeam = alive.length - mafiaTeam;

  if (mafiaKillers === 0) return '시민 팀';
  else if (mafiaTeam >= citizenTeam) return '마피아 팀';
  return null;
}

function generateEvidence(room, deadPlayers) {
  const alive = room.players.filter(p => !p.isDead);
  if (alive.length === 0) return null;
  
  const evidenceTypes = [];
  const realMafias = room.players.filter(p => ['mafia', 'spy', 'madam'].includes(p.role) && !p.isDead);

  if (alive.length >= 3 && realMafias.length > 0) {
    let m = realMafias[Math.floor(Math.random() * realMafias.length)];
    let others = alive.filter(p => p.id !== m.id).sort(() => 0.5 - Math.random()).slice(0, 2);
    let suspects = [m, ...others].sort(() => 0.5 - Math.random()).map(p => `#${p.playerNum} ${p.name}`);
    evidenceTypes.push(`[수사 기록] 용의선상에 오른 3명(${suspects.join(', ')}) 중 최소 1명 이상은 마피아 팀입니다.`);
  }

  if (realMafias.length > 0) {
    let m = realMafias[Math.floor(Math.random() * realMafias.length)];
    let isOdd = m.playerNum % 2 !== 0;
    evidenceTypes.push(`[CCTV 확보] 어젯밤 범행 현장을 빠져나간 자의 번호표는 [${isOdd ? '홀수' : '짝수'}]입니다.`);
  }

  if (room.nightActions.doctor) evidenceTypes.push(`[현장 단서] 현장에 구급키트가 떨어져 있습니다. 누군가 의사의 보호를 받았습니다.`);
  if (room.nightActions.madam) evidenceTypes.push(`[현장 단서] 짙은 향수 냄새가 남아있습니다. 누군가 마담의 유혹에 빠졌습니다.`);

  let chosenEvidence = evidenceTypes[Math.floor(Math.random() * evidenceTypes.length)] || "특이 단서를 찾지 못했습니다.";
  let receiver = alive[Math.floor(Math.random() * alive.length)];
  return { receiverId: receiver.id, text: chosenEvidence };
}

function resolveNight(room) {
  clearRoomTimer(room);
  let actions = room.nightActions;
  let deadThisNight = new Set();
  let blockedPlayers = new Set();

  if (actions.madam) blockedPlayers.add(actions.madam.target);

  if (actions.police && !blockedPlayers.has(actions.police.actor)) {
    let target = room.players.find(p => p.id === actions.police.target);
    let isMafia = target && target.role === 'mafia' ? true : false; 
    io.to(actions.police.actor).emit('system_msg', `🔍 조사 결과: [${target.name}]님은 [${isMafia ? '마피아' : '시민 팀(마피아 아님)'}] 입니다.`);
  }
  
  if (actions.medium && !blockedPlayers.has(actions.medium.actor)) {
    let target = room.players.find(p => p.id === actions.medium.target);
    io.to(actions.medium.actor).emit('system_msg', `🔮 영매 교감: 죽은 [${target.name}]님의 직업은 [${target.role}] 입니다.`);
  }

  if (actions.reporter && !blockedPlayers.has(actions.reporter.actor) && !room.reporterUsed) {
    let target = room.players.find(p => p.id === actions.reporter.target);
    if (target) {
      room.reporterUsed = true;
      room.morningNews = `📰 [아침 특종] 기자의 취재 결과, [${target.name}]님의 직업은 [${target.role}]로 밝혀졌습니다!`;
    }
  } else { room.morningNews = null; }

  let mafiaTarget = actions.mafia ? actions.mafia.target : null;
  let docTarget = actions.doctor && !blockedPlayers.has(actions.doctor.actor) ? actions.doctor.target : null;
  
  if (mafiaTarget && mafiaTarget !== docTarget) deadThisNight.add(mafiaTarget);

  if (actions.hunter && !blockedPlayers.has(actions.hunter.actor)) {
    if (deadThisNight.has(actions.hunter.actor)) deadThisNight.add(actions.hunter.target);
  }

  let lovers = room.players.filter(p => p.role === 'lover');
  if (lovers.length === 2) {
    if (deadThisNight.has(lovers[0].id)) deadThisNight.add(lovers[1].id);
    if (deadThisNight.has(lovers[1].id)) deadThisNight.add(lovers[0].id);
  }

  let killedNames = [];
  deadThisNight.forEach(id => {
    let p = room.players.find(p => p.id === id);
    if (p && !p.isDead) { p.isDead = true; killedNames.push(p.name); }
  });

  let evidence = generateEvidence(room, killedNames);
  if (evidence) io.to(evidence.receiverId).emit('evidence_received', evidence.text);

  const winner = checkWinCondition(room);

  room.phase = 'DAY_TALK';
  room.dayCount++;
  room.players.forEach(p => { p.whisperedToday = []; p.skipVote = false; });
  room.skipVotesCount = 0;

  io.to(room.code).emit('player_list_updated', room.players);
  io.to(room.code).emit('night_result', { killedNames, winner, dayCount: room.dayCount, news: room.morningNews });

  if (winner) return;

  room.goldenBellActive = false;
  room.goldenBellTimeout = setTimeout(() => {
    let dots = Math.floor(Math.random() * 5) + 4;
    room.goldenBellActive = true;
    room.goldenBellAnswer = dots;
    io.to(room.code).emit('golden_bell_start', { dots });
  }, 30000);

  startPhaseTimer(room, room.talkTime, () => startVote1(room));
}

function startVote1(room) {
  room.phase = 'DAY_VOTE1';
  room.votes1 = {};
  room.goldenBellActive = false;
  io.to(room.code).emit('player_list_updated', room.players);
  io.to(room.code).emit('phase_changed', { phase: 'DAY_VOTE1' });

  startPhaseTimer(room, 30, () => tallyVote1(room));
}

function tallyVote1(room) {
  clearRoomTimer(room);
  const counts = {};
  const votersOf = {}; 

  for (const [voterId, targetId] of Object.entries(room.votes1)) {
    let voter = room.players.find(p => p.id === voterId);
    let target = room.players.find(p => p.id === targetId);
    let weight = (voter && voter.role === 'politician') ? 2 : 1;
    
    counts[targetId] = (counts[targetId] || 0) + weight;
    if(!votersOf[targetId]) votersOf[targetId] = [];
    votersOf[targetId].push(`${voter.name}${weight>1?"(2표)":""}`);
  }

  let maxVote = 0, topTarget = null, isTie = false;
  for (const [tid, cnt] of Object.entries(counts)) {
    if (cnt > maxVote) { maxVote = cnt; topTarget = tid; isTie = false; } 
    else if (cnt === maxVote && maxVote > 0) { isTie = true; }
  }

  const summaryArr = [];
  for(let tId in votersOf){
    let target = room.players.find(p=>p.id===tId);
    if(target) summaryArr.push({ targetName: target.name, targetAvatar: target.avatar, voters: votersOf[tId] });
  }

  if (!topTarget || isTie || maxVote === 0) {
    io.to(room.code).emit('vote_summary_modal', { summaryArr, resultMsg: '동표/무투표로 처형 없이 밤으로 넘어갑니다.' });
    room.phase = 'VOTE_RESULT';
    io.to(room.code).emit('phase_sync', { nextPhase: 'NIGHT', suspectName: null });
    return;
  }

  const suspect = room.players.find(p => p.id === topTarget);
  room.suspectId = topTarget;
  
  io.to(room.code).emit('vote_summary_modal', { summaryArr, resultMsg: `최다 득표자 [${suspect.name}] 해명석으로 이동합니다.` });
  room.phase = 'VOTE_RESULT';
  io.to(room.code).emit('phase_sync', { nextPhase: 'TRIAL_DEFENSE', suspectName: suspect.name });
}

function startFinalVote(room) {
  room.phase = 'TRIAL_FINAL';
  room.votesFinal = { execute: 0, spare: 0, votedSockets: [] };
  io.to(room.code).emit('phase_changed', { phase: 'TRIAL_FINAL' });
  startPhaseTimer(room, 20, () => tallyFinalVote(room));
}

function tallyFinalVote(room) {
  clearRoomTimer(room);
  const suspect = room.players.find(p => p.id === room.suspectId);
  
  if (room.votesFinal.execute > room.votesFinal.spare) {
    if (suspect && suspect.role === 'politician') {
      io.to(room.code).emit('announcement', `최종 찬성 과반수! 하지만 [${suspect.name}]님은 정치인으로 처형이 면제됩니다!`);
    } else {
      if (suspect) suspect.isDead = true;
      if (suspect && suspect.role === 'lover') {
        let other = room.players.find(p => p.role === 'lover' && p.id !== suspect.id);
        if(other) other.isDead = true;
      }
      io.to(room.code).emit('announcement', `최종 투표 결과: [${suspect ? suspect.name : ''}]님이 처형되었습니다.`);
    }
  } else {
    io.to(room.code).emit('announcement', `최종 투표 결과: 처형이 무산되었습니다.`);
  }

  const winner = checkWinCondition(room);
  if (winner) {
    io.to(room.code).emit('player_list_updated', room.players);
    io.to(room.code).emit('night_result', { killedNames: [], winner: winner, dayCount: room.dayCount });
    return;
  }

  io.to(room.code).emit('player_list_updated', room.players);
  setTimeout(() => enterNightPhase(room), 3000);
}

function enterNightPhase(room) {
  room.phase = 'NIGHT';
  room.nightActions = {};
  io.to(room.code).emit('phase_changed', { phase: 'NIGHT' });
  startPhaseTimer(room, 30, () => resolveNight(room));
}

io.on('connection', (socket) => {
  const joinOrReconnect = (roomCode, playerName, token, isHostRequest) => {
    let room = rooms[roomCode];
    if (!room && isHostRequest) {
      room = rooms[roomCode] = {
        code: roomCode, hostId: null, phase: 'LOBBY', dayCount: 1, players: [],
        votes1: {}, votesFinal: { execute: 0, spare: 0, votedSockets: [] },
        nightActions: {}, timerInterval: null, remainingTime: 0,
        talkTime: 180, skipVotesCount: 0, reporterUsed: false
      };
    }
    if (!room) return socket.emit('error_msg', '존재하지 않는 방입니다.');

    let existingPlayer = room.players.find(p => p.token === token);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      socket.join(roomCode);
      if (['mafia','spy','madam'].includes(existingPlayer.role)) socket.join(roomCode + '_mafia');
      if (existingPlayer.role === 'lover') socket.join(roomCode + '_lover');
      
      socket.emit('reconnect_success', { 
        roomCode, role: existingPlayer.role, phase: room.phase, 
        isDead: existingPlayer.isDead, isHost: existingPlayer.isHost 
      });
      io.to(roomCode).emit('player_list_updated', room.players);
      return;
    }

    if (room.phase !== 'LOBBY') return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
    
    const newToken = token || Math.random().toString(36).substr(2, 9);
    const isHost = isHostRequest || room.players.length === 0;
    
    socket.join(roomCode);
    room.players.push({
      id: socket.id, name: playerName, token: newToken, role: null, 
      isDead: false, isHost: isHost, whisperedToday: [], skipVote: false,
      playerNum: room.players.length + 1,
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)]
    });
    
    if (isHost) room.hostId = socket.id;
    socket.emit(isHost ? 'room_created' : 'join_success', { roomCode, token: newToken });
    io.to(roomCode).emit('player_list_updated', room.players);
  };

  socket.on('create_room', ({ hostName, token }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) roomCode = generateRoomCode();
    joinOrReconnect(roomCode, hostName, token, true);
  });

  socket.on('join_room', ({ roomCode, playerName, token }) => joinOrReconnect(roomCode, playerName, token, false));

  socket.on('start_game', ({ roomCode, selectedRoles }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;

    let pCount = room.players.length;
    let roles = [...selectedRoles];
    let currentMafiaTeam = roles.filter(r => ['mafia','spy','madam'].includes(r)).length;
    let targetMafiaCount = Math.max(1, Math.floor(pCount / 4));
    
    while(roles.length < pCount) {
      if (currentMafiaTeam < targetMafiaCount) { roles.push('mafia'); currentMafiaTeam++; } 
      else { roles.push('citizen'); }
    }
    roles.sort(() => Math.random() - 0.5);

    room.players.forEach((p, idx) => {
      p.role = roles[idx];
      io.to(p.id).emit('role_assigned', { role: p.role });
      if (['mafia', 'spy', 'madam'].includes(p.role)) socket.join(roomCode + '_mafia');
      if (p.role === 'lover') socket.join(roomCode + '_lover');
    });

    room.phase = 'DAY_TALK';
    io.to(roomCode).emit('player_list_updated', room.players);
    io.to(roomCode).emit('phase_changed', { phase: 'DAY_TALK' });
    startPhaseTimer(room, room.talkTime, () => startVote1(room));
  });

  socket.on('skip_vote_req', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_TALK') return;
    let p = room.players.find(p => p.id === socket.id);
    if (p && !p.isDead && !p.skipVote) {
      p.skipVote = true;
      room.skipVotesCount++;
      let alive = room.players.filter(x => !x.isDead).length;
      io.to(roomCode).emit('system_msg', `[투표 조기 전환] 동의: ${room.skipVotesCount} / ${Math.ceil(alive/2)}명`);
      if (room.skipVotesCount >= Math.ceil(alive / 2)) {
        clearRoomTimer(room); startVote1(room);
      }
    }
  });

  socket.on('host_next_phase', ({ roomCode, nextPhase, suspectName }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    if (nextPhase === 'TRIAL_DEFENSE') {
      room.phase = 'TRIAL_DEFENSE';
      io.to(room.code).emit('phase_changed', { phase: 'TRIAL_DEFENSE', suspectName });
      startPhaseTimer(room, 60, () => startFinalVote(room));
    } else if (nextPhase === 'NIGHT') {
      enterNightPhase(room);
    }
  });

  socket.on('send_anon_tip', ({ roomCode, msg }) => io.to(roomCode).emit('anon_tip_broadcast', msg));
  
  socket.on('public_chat', ({ roomCode, msg, senderName }) => {
    let p = rooms[roomCode]?.players.find(x => x.id === socket.id);
    if (!p) return;
    io.to(roomCode).emit('public_chat_received', { sender: `${p.avatar} ${senderName}`, text: msg, isDead: p.isDead });
  });

  socket.on('group_chat', ({ roomCode, group, msg, senderName }) => {
    let p = rooms[roomCode]?.players.find(x => x.id === socket.id);
    io.to(roomCode + '_' + group).emit('group_chat_received', { sender: `${p.avatar} ${senderName}`, text: msg, group });
  });

  socket.on('send_whisper', ({ roomCode, targetId, message }) => {
    const room = rooms[roomCode]; if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!sender || sender.isDead || !target || target.isDead) return;
    
    let isLoverPair = sender.role === 'lover' && target.role === 'lover';
    if (!isLoverPair) {
      sender.whisperedToday = sender.whisperedToday || [];
      if (!sender.whisperedToday.includes(targetId)) {
        if (sender.whisperedToday.length >= 2) return socket.emit('error_msg', '귓속말은 하루 2명까지만 가능합니다.');
        sender.whisperedToday.push(targetId);
      }
    }
    
    // 수신자에게 전송
    io.to(target.id).emit('whisper_received', { senderName: `${sender.avatar} ${sender.name}`, message });
    // 송신자에게 성공 및 기록용 로그 전송 (비밀 수첩 기록용)
    socket.emit('whisper_sent_success', { targetName: `${target.avatar} ${target.name}`, message });
  });

  socket.on('cast_vote1', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'DAY_VOTE1') return;
    room.votes1[socket.id] = targetId;
    io.to(roomCode).emit('vote_update', room.votes1);
    const aliveCount = room.players.filter(p => !p.isDead).length;
    if (Object.keys(room.votes1).length >= aliveCount) tallyVote1(room);
  });

  socket.on('cast_vote_final', ({ roomCode, isExecute }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'TRIAL_FINAL') return;
    if (room.votesFinal.votedSockets.includes(socket.id)) return;
    room.votesFinal.votedSockets.push(socket.id);
    if (isExecute) room.votesFinal.execute++; else room.votesFinal.spare++;
    const aliveCount = room.players.filter(p => !p.isDead).length;
    if (room.votesFinal.votedSockets.length >= aliveCount) tallyFinalVote(room);
  });

  socket.on('night_action', ({ roomCode, actionType, targetId }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'NIGHT') return;
    room.nightActions[actionType] = { actor: socket.id, target: targetId };
    if (actionType === 'mafia') {
      let target = room.players.find(p => p.id === targetId);
      io.to(roomCode + '_mafia').emit('system_msg', `🔪 타깃 지목 완료: [${target ? target.name : ''}]`);
    }
  });

  socket.on('golden_bell_answer', ({ roomCode, ans }) => {
    const room = rooms[roomCode]; if (!room || !room.goldenBellActive) return;
    if (parseInt(ans) === room.goldenBellAnswer) {
      room.goldenBellActive = false; 
      io.to(roomCode).emit('system_msg', `🔔 누군가 퀴즈 정답을 맞혀 비밀 힌트를 획득했습니다!`);
      let alive = room.players.filter(p=>!p.isDead);
      let randP = alive[Math.floor(Math.random() * alive.length)];
      let team = ['mafia','spy','madam'].includes(randP.role) ? '마피아 팀' : '시민 팀';
      
      // 정답자에게 힌트 전송 (수첩 기록용)
      socket.emit('golden_bell_hint', `[🔔 골든벨 힌트] ${randP.avatar} ${randP.name}님은 [${team}] 소속입니다.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('마피아 마스터 서버 가동: 포트 ' + PORT));
