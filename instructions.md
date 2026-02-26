Build a production-ready web application that looks and behaves like Cursor AI editor, but uses an OpenCode AI agent as the backend coding engine.

GOAL:
Create a browser-based AI coding IDE where users can chat with an AI agent, edit code, run commands, and generate full applications.

CORE FEATURES:

1. Cursor-style UI layout:
- Left panel: AI chat / agent interaction
- Center: Monaco code editor (VS Code-like)
- Right panel: file tree explorer
- Bottom panel: terminal output
- Resizable panels
- Clean modern UI similar to Cursor

2. AI Agent Integration:
- Backend executes OpenCode CLI
- User prompt → backend → OpenCode → stream output
- AI can create/edit files
- AI can run shell commands
- AI can generate full projects
- AI can fix errors automatically
- Stream agent output in real time

3. File System Management:
- Create / edit / delete files
- Folder structure view
- Live file updates
- Project workspace per session
- File watcher to sync changes

4. Terminal:
- Browser terminal using xterm.js
- Command execution in workspace
- Show logs and errors

5. Backend Agent Controller:
- Node.js server
- Uses child_process to run OpenCode
- WebSocket streaming of agent output
- Workspace isolation per user
- REST + WebSocket API

6. Project Generation Workflow:
- User enters app idea
- AI plans architecture
- AI creates files
- AI installs dependencies
- AI runs project
- AI fixes errors automatically

7. Autonomous Agent Mode:
- Agent creates step-by-step plan
- Executes tasks continuously
- Fixes errors without asking
- Continues until goal complete

TECH STACK:

Frontend:
- React
- Vite
- TypeScript
- Tailwind CSS
- Monaco Editor
- xterm.js
- WebSocket client

Backend:
- Node.js
- Express
- WebSocket server
- OpenCode CLI integration

UI REQUIREMENTS:
- Modern minimal design
- Dark theme
- Responsive layout
- Smooth panel resizing
- Loading states
- Streaming responses

ARCHITECTURE:
- Frontend communicates with backend agent server
- Backend controls OpenCode process
- Workspace stored on server
- Real-time streaming of AI output

DELIVERABLES:
- Complete project structure
- Backend and frontend code
- Clear folder organization
- Working MVP implementation
- Setup instructions
- Example agent workflow

EXTRA:
- Design for scalability
- Clean architecture
- Modular components
- Error handling
- Production-ready patterns