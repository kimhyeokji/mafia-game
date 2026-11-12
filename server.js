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
const rName = { 'mafia':'마피아', 'spy':'스파이', 'madam':'마담', 'police':'경찰', 'doctor':'의사', 'reporter':'기자', 'politician':'정치인', 'hunter':'사냥꾼', 'medium':'영매', 'lover':'연인', 'citizen':'시민' };

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
      if (onEndCallback) {
        try { onEndCallback(); } 
        catch (e) { console.error("타이머 콜백 에러 방어:", e); }
      }
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

function generateEvidence(room) {
  const alive = room.players.filter(p => !p.isDead);
  if (alive.length === 0) return null;
  
  const evidenceTypes = [];
  const realMafias = room.players.filter(p => ['mafia', 'spy', 'madam'].includes(p.role) && !p.isDead);

  if (alive.length >= 3 && realMafias.length > 0) {
    let m = realMafias[Math.floor(Math.random() * realMafias.length)];
    let others = alive.filter(p => p.token !== m.token).sort(() => 0.5 - Math.random()).slice(0, 2);
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
  return { receiverToken: receiver.token, receiverId: receiver.id, text: chosenEvidence };
}

function resolveNight(room) {
  try {
    clearRoomTimer(room);
    let actions = room.nightActions;
    let deadThisNight = new Set();
    let blockedPlayers = new Set(); 

    if (actions.madam) blockedPlayers.add(actions.madam.targetToken);

    if (actions.police && !blockedPlayers.has(actions.police.actorToken)) {
      let target = room.players.find(p => p.token === actions.police.targetToken);
      let isMafia = target && target.role === 'mafia' ? true : false; 
      let actor = room.players.find(p => p.token === actions.police.actorToken);
      if(actor) io.to(actor.id).emit('system_msg', `🔍 조사 결과: [${target ? target.name : '알수없음'}]님은 [${isMafia ? '마피아' : '시민 팀(마피아 아님)'}] 입니다.`);
    }
    
    if (actions.reporter && !blockedPlayers.has(actions.reporter.actorToken) && !room.reporterUsed) {
      let target = room.players.find(p => p.token === actions.reporter.targetToken);
      if (target) {
        room.reporterUsed = true;
        let translatedRole = rName[target.role] || target.role;
        room.morningNews = `📰 [아침 특종] 기자의 취재 결과, [${target.name}]님의 직업은 [${translatedRole}]로 밝혀졌습니다!`;
      }
    } else { room.morningNews = null; }

    let mafiaTargetToken = actions.mafia ? actions.mafia.targetToken : null;
    let docTargetToken = actions.doctor && !blockedPlayers.has(actions.doctor.actorToken) ? actions.doctor.targetToken : null;
    
    if (mafiaTargetToken && mafiaTargetToken !== docTargetToken) deadThisNight.add(mafiaTargetToken);

    if (actions.hunter && !blockedPlayers.has(actions.hunter.actorToken)) {
      if (deadThisNight.has(actions.hunter.actorToken)) deadThisNight.add(actions.hunter.targetToken);
    }

    let lovers = room.players.filter(p => p.role === 'lover');
    if (lovers.length === 2) {
      if (deadThisNight.has(lovers[0].token)) deadThisNight.add(lovers[1].token);
      if (deadThisNight.has(lovers[1].token)) deadThisNight.add(lovers[0].token);
    }

    let killedNames = [];
    deadThisNight.forEach(tkn => {
      let p = room.players.find(p => p.token === tkn);
      if (p && !p.isDead) { 
        p.isDead = true; 
        let team = ['mafia','spy','madam'].includes(p.role) ? '마피아 팀' : '시민 팀';
        killedNames.push(`${p.name}(${team})`); 
      }
    });

    let evidence = generateEvidence(room);
    if (evidence && evidence.receiverId) io.to(evidence.receiverId).emit('evidence_received', evidence.text);

    const winner = checkWinCondition(room);

    room.phase = 'DAY_TALK';
    room.dayCount++;
    room.dayStartTime = Date.now();
    room.skipVotesCount = 0;
    
    room.players.forEach(p => { 
      p.whisperedToday = []; 
      p.skipVote = false; 
      p.extraVote = false;
    });

    io.to(room.code).emit('player_list_updated', room.players);
    io.to(room.code).emit('night_result', { killedNames, winner, dayCount: room.dayCount, news: room.morningNews });

    if (winner) return;

    io.to(room.code).emit('phase_changed', { phase: 'DAY_TALK' });

    room.goldenBellActive = false;
    room.goldenBellTimeout = setTimeout(() => {
      let dots = Math.floor(Math.random() * 5) + 4;
      room.goldenBellActive = true;
      room.goldenBellAnswer = dots;
      io.to(room.code).emit('golden_bell_start', { dots });
    }, 30000);

    startPhaseTimer(room, room.talkTime, () => startVote1(room));

  } catch (error) {
    console.error("resolveNight 에러 방어:", error);
  }
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
  try {
    clearRoomTimer(room);
    const counts = {};
    const votersOf = {}; 

    for (const [voterToken, targetToken] of Object.entries(room.votes1)) {
      let voter = room.players.find(p => p.token === voterToken);
      let target = room.players.find(p => p.token === targetToken);
      if(!voter || !target) continue;
      
      let baseWeight = (voter.role === 'politician') ? 2 : 1;
      let extra = voter.extraVote ? 1 : 0;
      let weight = baseWeight + extra;
      
      counts[targetToken] = (counts[targetToken] || 0) + weight;
      if(!votersOf[targetToken]) votersOf[targetToken] = [];
      votersOf[targetToken].push(`${voter.name}${weight>1 ? `(${weight}표)` : ""}`);
    }

    let maxVote = 0, topTargetToken = null, isTie = false;
    for (const [tkn, cnt] of Object.entries(counts)) {
      if (cnt > maxVote) { maxVote = cnt; topTargetToken = tkn; isTie = false; } 
      else if (cnt === maxVote && maxVote > 0) { isTie = true; }
    }

    const summaryArr = [];
    for(let tkn in votersOf){
      let target = room.players.find(p=>p.token===tkn);
      if(target) summaryArr.push({ targetName: target.name, targetAvatar: target.avatar, voters: votersOf[tkn] });
    }

    room.voteResultData = { summaryArr, resultMsg: '' }; 

    if (!topTargetToken || isTie || maxVote === 0) {
      room.voteResultData.resultMsg = '동표/무투표로 처형 없이 밤으로 넘어갑니다.';
      io.to(room.code).emit('vote_summary_modal', room.voteResultData);
      room.phase = 'VOTE_RESULT';
      io.to(room.code).emit('phase_sync', { nextPhase: 'NIGHT', suspectName: null, suspectToken: null });
      return;
    }

    const suspect = room.players.find(p => p.token === topTargetToken);
    room.suspectToken = topTargetToken;
    room.suspectName = suspect.name;
    
    room.voteResultData.resultMsg = `최다 득표자 [${suspect.name}] 해명석으로 이동합니다.`;
    io.to(room.code).emit('vote_summary_modal', room.voteResultData);
    room.phase = 'VOTE_RESULT';
    io.to(room.code).emit('phase_sync', { nextPhase: 'TRIAL_DEFENSE', suspectName: suspect.name, suspectToken: suspect.token });

  } catch (error) {
    console.error("tallyVote1 에러 방어:", error);
  }
}

function startFinalVote(room) {
  room.phase = 'TRIAL_FINAL';
  room.votesFinal = { execute: 0, spare: 0, votedTokens: [] };
  io.to(room.code).emit('phase_changed', { phase: 'TRIAL_FINAL' });
  startPhaseTimer(room, 20, () => tallyFinalVote(room));
}

function tallyFinalVote(room) {
  try {
    clearRoomTimer(room);
    const suspect = room.players.find(p => p.token === room.suspectToken);
    let resultMsg = "";
    
    if (room.votesFinal.execute > room.votesFinal.spare) {
      if (suspect && suspect.role === 'politician') {
        resultMsg = `[처형 무산] 과반수 찬성! 하지만 [${suspect.name}]님은 '정치인'으로 처형이 면제됩니다!`;
      } else {
        if (suspect) {
          suspect.isDead = true;
          let sTeam = ['mafia','spy','madam'].includes(suspect.role) ? '마피아 팀' : '시민 팀';
          resultMsg = `[처형 집행] 투표 결과에 따라 [${suspect.name}]님이 처형되었습니다.\n(정체: ${sTeam})`;
        }
        
        if (suspect && suspect.role === 'lover') {
          let other = room.players.find(p => p.role === 'lover' && p.token !== suspect.token);
          if(other) {
            other.isDead = true;
            let oTeam = ['mafia','spy','madam'].includes(other.role) ? '마피아 팀' : '시민 팀';
            resultMsg += `\n\n[연인 동반 사망] [${other.name}]님도 충격으로 함께 사망했습니다. (정체: ${oTeam})`;
          }
        }
      }
    } else {
      resultMsg = `[처형 무산] 반대표가 많아 처형이 무산되었습니다.`;
    }

    room.phase = 'TRIAL_RESULT';
    io.to(room.code).emit('phase_changed', { phase: 'TRIAL_RESULT', suspectName: resultMsg });

    const winner = checkWinCondition(room);
    if (winner) {
      setTimeout(() => {
        io.to(room.code).emit('player_list_updated', room.players);
        io.to(room.code).emit('night_result', { killedNames: [], winner: winner, dayCount: room.dayCount });
      }, 4000);
      return;
    }

    io.to(room.code).emit('player_list_updated', room.players);
    setTimeout(() => enterNightPhase(room), 6000);

  } catch (error) {
    console.error("tallyFinalVote 에러 방어:", error);
    enterNightPhase(room);
  }
}

function enterNightPhase(room) {
  room.phase = 'NIGHT';
  room.nightActions = {};
  io.to(room.code).emit('phase_changed', { phase: 'NIGHT' });
  startPhaseTimer(room, 60, () => resolveNight(room));
}

io.on('connection', (socket) => {
  
  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.isOffline = true;
        io.to(roomCode).emit('player_list_updated', room.players);
        break;
      }
    }
  });

  const joinOrReconnect = (roomCode, playerName, token, isHostRequest, userAvatar) => {
    let room = rooms[roomCode];
    if (!room && isHostRequest) {
      room = rooms[roomCode] = {
        code: roomCode, hostId: null, phase: 'LOBBY', dayCount: 1, players: [],
        votes1: {}, votesFinal: { execute: 0, spare: 0, votedTokens: [] },
        nightActions: {}, timerInterval: null, remainingTime: 0,
        talkTime: 180, skipVotesCount: 0, reporterUsed: false,
        dayStartTime: Date.now()
      };
    }
    if (!room) return socket.emit('error_msg', '존재하지 않는 방입니다.');

    let existingPlayer = room.players.find(p => p.token === token);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.isOffline = false;
      // 재접속 시에도 아바타 업데이트 허용 (선택 사항)
      if(userAvatar && room.phase === 'LOBBY') existingPlayer.avatar = userAvatar;

      socket.join(roomCode);
      if (['mafia','spy','madam'].includes(existingPlayer.role)) socket.join(roomCode + '_mafia');
      if (existingPlayer.role === 'lover') socket.join(roomCode + '_lover');
      if (existingPlayer.isHost) room.hostId = socket.id;
      
      socket.emit('reconnect_success', { 
        roomCode, role: existingPlayer.role, phase: room.phase, 
        isDead: existingPlayer.isDead, isHost: existingPlayer.isHost,
        players: room.players, suspectName: room.suspectName, suspectToken: room.suspectToken,
        remainingTime: room.remainingTime,
        skipVotesCount: room.skipVotesCount 
      });
      
      if (room.phase === 'VOTE_RESULT' && room.voteResultData) {
        socket.emit('vote_summary_modal', room.voteResultData);
      }
      
      io.to(roomCode).emit('player_list_updated', room.players);
      return;
    }

    if (room.phase !== 'LOBBY') return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
    
    const newToken = token || Math.random().toString(36).substr(2, 9);
    const isHost = isHostRequest || room.players.length === 0;
    
    socket.join(roomCode);
    room.players.push({
      id: socket.id, name: playerName, token: newToken, role: null, 
      isDead: false, isOffline: false, isHost: isHost, whisperedToday: [], 
      skipVote: false, extraVote: false,
      playerNum: room.players.length + 1,
      avatar: userAvatar || '👤' // [수정] 클라이언트에서 선택한 아바타 반영
    });
    
    if (isHost) room.hostId = socket.id;
    socket.emit(isHost ? 'room_created' : 'join_success', { roomCode, token: newToken });
    io.to(roomCode).emit('player_list_updated', room.players);
  };

  // [수정] 아바타 정보를 포함하여 방 생성/참가
  socket.on('create_room', ({ hostName, token, avatar }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) roomCode = generateRoomCode();
    joinOrReconnect(roomCode, hostName, token, true, avatar);
  });

  socket.on('join_room', ({ roomCode, playerName, token, avatar }) => {
    joinOrReconnect(roomCode, playerName, token, false, avatar);
  });

  socket.on('start_game', ({ roomCode, selectedRoles, mafiaCount }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;

    let pCount = room.players.length;
    let roles = [...selectedRoles];
    let currentMafiaTeam = roles.filter(r => ['mafia','spy','madam'].includes(r)).length;
    let targetMafiaCount = Math.max(1, mafiaCount || Math.floor(pCount / 4));
    
    while(roles.length < pCount) {
      if (currentMafiaTeam < targetMafiaCount) { roles.push('mafia'); currentMafiaTeam++; } 
      else { roles.push('citizen'); }
    }
    
    let roleCounts = {};
    roles.forEach(r => roleCounts[r] = (roleCounts[r] || 0) + 1);
    
    let mTeam = ['mafia','spy','madam'].filter(r=>roleCounts[r]).map(r=>`${rName[r]} ${roleCounts[r]}`).join(', ');
    let cTeam = ['police','doctor','reporter','politician','hunter','medium','lover','citizen'].filter(r=>roleCounts[r]).map(r=>`${rName[r]} ${roleCounts[r]}`).join(', ');
    let mTotal = ['mafia','spy','madam'].reduce((a,b)=>a+(roleCounts[b]||0), 0);
    let cTotal = pCount - mTotal;

    let startMsg = `총 ${pCount}명 직업 배정 완료! [🔴마피아 팀 ${mTotal}명 / 🔵시민 팀 ${cTotal}명]\n(상세: ${mTeam} vs ${cTeam})`;

    roles.sort(() => Math.random() - 0.5);

    room.players.forEach((p, idx) => {
      p.role = roles[idx];
      io.to(p.id).emit('role_assigned', { role: p.role });
      
      const targetSocket = io.sockets.sockets.get(p.id);
      if (targetSocket) {
        if (['mafia', 'spy', 'madam'].includes(p.role)) targetSocket.join(roomCode + '_mafia');
        if (p.role === 'lover') targetSocket.join(roomCode + '_lover');
      }
    });

    room.phase = 'DAY_TALK';
    room.dayStartTime = Date.now(); 
    io.to(roomCode).emit('player_list_updated', room.players);
    io.to(roomCode).emit('phase_changed', { phase: 'DAY_TALK' });
    io.to(roomCode).emit('public_chat_received', { sender: '🎮 시스템', text: startMsg, isDead: false });

    startPhaseTimer(room, room.talkTime, () => startVote1(room));
  });

  socket.on('skip_vote_toggle', ({ roomCode, state }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_TALK') return;
    
    if (Date.now() - room.dayStartTime < 60000) return;
    
    let p = room.players.find(p => p.id === socket.id);
    if (p && !p.isDead) {
      p.skipVote = state;
      let skipCount = room.players.filter(x => x.skipVote && !x.isDead && !x.isOffline).length;
      let alive = room.players.filter(x => !x.isDead && !x.isOffline).length;
      let required = Math.ceil(alive / 2);
      
      room.skipVotesCount = skipCount;
      io.to(roomCode).emit('skip_vote_update', { current: skipCount, required: required });
      
      if (skipCount >= required) {
        clearRoomTimer(room); 
        startVote1(room);
      }
    }
  });
  
  socket.on('skip_defense', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'TRIAL_DEFENSE') return;
    if (room.suspectToken && room.players.find(p => p.id === socket.id && p.token === room.suspectToken)) {
      clearRoomTimer(room);
      startFinalVote(room);
    }
  });

  socket.on('host_next_phase', ({ roomCode, nextPhase, suspectName, suspectToken }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    if (nextPhase === 'TRIAL_DEFENSE') {
      room.phase = 'TRIAL_DEFENSE';
      io.to(room.code).emit('phase_changed', { phase: 'TRIAL_DEFENSE', suspectName, suspectToken });
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

  socket.on('send_whisper', ({ roomCode, targetToken, message }) => {
    const room = rooms[roomCode]; if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.token === targetToken);
    if (!sender || sender.isDead || !target || target.isDead) return;
    
    let isLoverPair = sender.role === 'lover' && target.role === 'lover';
    if (!isLoverPair) {
      sender.whisperedToday = sender.whisperedToday || [];
      if (!sender.whisperedToday.includes(targetToken)) {
        if (sender.whisperedToday.length >= 2) return socket.emit('error_msg', '귓속말은 하루 2명까지만 가능합니다.');
        sender.whisperedToday.push(targetToken);
      }
    }
    
    io.to(target.id).emit('whisper_received', { senderName: `${sender.avatar} ${sender.name}`, message });
    socket.emit('whisper_sent_success', { targetName: `${target.avatar} ${target.name}`, message });
  });

  socket.on('cast_vote1', ({ roomCode, targetToken }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'DAY_VOTE1') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me) return;
    
    room.votes1[me.token] = targetToken; 
    
    io.to(roomCode).emit('vote_update', room.votes1);
    
    const aliveAndOnlineCount = room.players.filter(p => !p.isDead && !p.isOffline).length;
    if (Object.keys(room.votes1).length >= aliveAndOnlineCount) tallyVote1(room);
  });

  socket.on('cast_vote_final', ({ roomCode, isExecute }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'TRIAL_FINAL') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me) return;

    if (room.votesFinal.votedTokens.includes(me.token)) return;
    room.votesFinal.votedTokens.push(me.token);
    if (isExecute) room.votesFinal.execute++; else room.votesFinal.spare++;
    
    const aliveAndOnlineCount = room.players.filter(p => !p.isDead && !p.isOffline).length;
    if (room.votesFinal.votedTokens.length >= aliveAndOnlineCount) tallyFinalVote(room);
  });

  socket.on('night_action', ({ roomCode, actionType, targetToken }) => {
    const room = rooms[roomCode]; if (!room || room.phase !== 'NIGHT') return;
    const me = room.players.find(p => p.id === socket.id);
    room.nightActions[actionType] = { actorToken: me.token, targetToken: targetToken };
    if (actionType === 'mafia') {
      let target = room.players.find(p => p.token === targetToken);
      io.to(roomCode + '_mafia').emit('system_msg', `🔪 타깃 지목 완료: [${target ? target.name : '알수없음'}]`);
    }
  });

  socket.on('golden_bell_answer', ({ roomCode, ans }) => {
    const room = rooms[roomCode]; if (!room || !room.goldenBellActive) return;
    if (parseInt(ans) === room.goldenBellAnswer) {
      room.goldenBellActive = false; 
      let solver = room.players.find(p => p.id === socket.id);
      if (solver) solver.extraVote = true; 
      
      io.to(roomCode).emit('system_msg', `🔔 [${solver.name}]님이 골든벨 정답을 맞춰 오늘 투표에서 [투표권 +1장]을 획득했습니다!`);
      io.to(roomCode).emit('golden_bell_closed');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('마피아 100% 무중단 서버 가동 완료: 포트 ' + PORT));
