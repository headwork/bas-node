# Powershell에서 Command Prompt 변경
    setting > terminal 이동
    cmd console로 실행 : "terminal.integrated.defaultProfile.windows": "Command Prompt",
    
# terminal실행시 path 추가
```
    "terminal.integrated.env.windows": {
        "path":"D:/ProgramFile/nodejs/node-v22.14.0-win-x64"
    }
```

# launch.json
```
"configurations": [
    {
        ...
        "runtimeExecutable": "D:\\Programs\\node-v22.14.0-win-x64\\node",
        "args":["test", "port=3000"]
    }
]
```

