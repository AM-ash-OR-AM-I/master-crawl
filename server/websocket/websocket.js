const clients = new Map();

function setupWebSocket(app) {
  app.ws('/ws', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    clients.set(clientId, ws);
    
    console.log(`✅ WebSocket client connected: ${clientId}`);
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        if (data.type === 'subscribe') {
          // Client wants to subscribe to job updates
          ws.jobId = data.jobId;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });
    
    ws.on('close', () => {
      clients.delete(clientId);
      console.log(`❌ WebSocket client disconnected: ${clientId}`);
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(clientId);
    });
  });
}

function broadcastStatusUpdate(jobId) {
  const message = JSON.stringify({
    type: 'status_update',
    jobId,
    timestamp: new Date().toISOString(),
  });
  
  // Send to all clients (or filter by jobId subscription)
  for (const [clientId, ws] of clients.entries()) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(message);
      } catch (error) {
        console.error(`Error sending to client ${clientId}:`, error);
        clients.delete(clientId);
      }
    }
  }
}

module.exports = { setupWebSocket, broadcastStatusUpdate };

