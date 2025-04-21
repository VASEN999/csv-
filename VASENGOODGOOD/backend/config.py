import os
from datetime import timedelta

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key'
    BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
    CSV_FOLDER = os.path.join(UPLOAD_FOLDER, 'csv')
    PHOTOS_FOLDER = os.path.join(UPLOAD_FOLDER, 'photos')
    PASSPORTS_FOLDER = os.path.join(UPLOAD_FOLDER, 'passports')
    
    # 确保所有目录都存在
    for folder in [UPLOAD_FOLDER, CSV_FOLDER, PHOTOS_FOLDER, PASSPORTS_FOLDER]:
        os.makedirs(folder, exist_ok=True)
    
    MAX_CONTENT_LENGTH = 200 * 1024 * 1024  # 200MB
    ALLOWED_EXTENSIONS = {
        'csv': {'csv'},
        'photo': {'jpg', 'jpeg', 'png', 'bmp'},
        'passport': {'pdf'}
    }
    MAX_FILE_SIZE = {
        'csv': 10 * 1024 * 1024,  # 10MB
        'photo': 5 * 1024 * 1024,  # 5MB
        'passport': 100 * 1024 * 1024  # 100MB
    }
    
    # Coze API 配置
    COZE_API_KEY = 'pat_0J6n6POAc1xrIapKnoIpfY0eaNLqx4vwO7JBGwmz1ry7VGvEUilmB5kEwvzjMiTi'
    COZE_BOT_ID = '7494531295393939482'

    COZE_API_URL = os.environ.get('COZE_API_URL')

    # 缓存基本配置
    CACHE_BASE_CONFIG = {
        'CACHE_DEFAULT_TIMEOUT': 600,  # 缓存默认超时时间（秒）
        'CACHE_KEY_PREFIX': 'passport_',  # 缓存键前缀
    }
    
    # 启用Redis缓存的标志
    USE_REDIS_CACHE = os.environ.get('USE_REDIS_CACHE', 'False').lower() == 'true'
    USE_FILESYSTEM_CACHE = os.environ.get('USE_FILESYSTEM_CACHE', 'False').lower() == 'true'
    
    # 智能缓存类型选择
    if USE_REDIS_CACHE:
        # Redis缓存配置
        REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
        CACHE_CONFIG = CACHE_BASE_CONFIG.copy()
        CACHE_CONFIG.update({
            'CACHE_TYPE': 'RedisCache',
            'CACHE_REDIS_URL': REDIS_URL,
        })
    elif USE_FILESYSTEM_CACHE:
        # 文件系统缓存配置
        CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cache')
        CACHE_CONFIG = CACHE_BASE_CONFIG.copy()
        CACHE_CONFIG.update({
            'CACHE_TYPE': 'FileSystemCache',
            'CACHE_DIR': CACHE_DIR,
        })
    else:
        # 内存缓存配置 (SimpleCache)
        CACHE_THRESHOLD = int(os.environ.get('CACHE_THRESHOLD', '1000'))
        CACHE_CONFIG = CACHE_BASE_CONFIG.copy()
        CACHE_CONFIG.update({
            'CACHE_TYPE': 'SimpleCache',
            'CACHE_THRESHOLD': CACHE_THRESHOLD,  # 最大缓存项数
        }) 