from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
import os
from config import Config
from utils.csv_handler import CSVHandler
from utils.pdf_handler import PDFHandler
from utils.coze_handler import CozeHandler
import hashlib
import json
import time
import logging
from flask_caching import Cache
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__, 
    template_folder='../frontend/templates',
    static_folder='../frontend/static'
)
app.config.from_object(Config)

# 使用增强的缓存配置
cache = Cache()
cache.init_app(app, config=app.config['CACHE_CONFIG'])

# 记录当前使用的缓存类型
logger.info(f"使用的缓存类型: {app.config['CACHE_CONFIG']['CACHE_TYPE']}")

# 创建线程池
MAX_WORKERS = 6  # 最大线程数
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
progress_lock = Lock()  # 用于保护进度更新

# 确保上传目录存在
for folder in [app.config['CSV_FOLDER'], app.config['PHOTOS_FOLDER'], app.config['PASSPORTS_FOLDER']]:
    os.makedirs(folder, exist_ok=True)

def allowed_file(filename, file_type):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS'][file_type]

def check_file_size(file, file_type):
    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    return size <= app.config['MAX_FILE_SIZE'][file_type]

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload/csv', methods=['POST'])
def upload_csv():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件上传'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename, 'csv'):
        return jsonify({'error': '不支持的文件类型'}), 400
    
    if not check_file_size(file, 'csv'):
        return jsonify({'error': f'文件太大，最大允许 {app.config["MAX_FILE_SIZE"]["csv"] // (1024 * 1024)}MB'}), 413
    
    try:
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['CSV_FOLDER'], filename)
        file.save(filepath)
        
        csv_handler = CSVHandler(filepath, cache=cache)
        data = csv_handler.to_json()
        
        if not data:
            return jsonify({
                'error': 'CSV 文件为空或格式不正确'
            }), 400
            
        return jsonify({
            'message': 'CSV文件上传成功',
            'data': data
        })
    except Exception as e:
        return jsonify({
            'error': str(e)
        }), 500

@app.route('/upload/passport', methods=['POST'])
def upload_passport():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件上传'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename, 'passport'):
        return jsonify({'error': '不支持的文件类型'}), 400
    
    if not check_file_size(file, 'passport'):
        return jsonify({'error': f'文件太大，最大允许 {app.config["MAX_FILE_SIZE"]["passport"] // (1024 * 1024)}MB'}), 413
    
    try:
        # 计算文件哈希值
        file_content = file.read()
        file_hash = hashlib.sha256(file_content).hexdigest()
        file.seek(0)  # 重置文件指针
        
        # 使用哈希值作为文件名
        filename = f"{file_hash}.pdf"
        filepath = os.path.join(app.config['PASSPORTS_FOLDER'], filename)
        
        # 检查文件是否已存在
        is_new_file = not os.path.exists(filepath)
        
        if is_new_file:
            file.save(filepath)
            app.logger.info(f"保存新文件: {filename}")
            
            # 清除与该文件相关的缓存
            # 1. 清除Flask缓存
            cache_key = f"pdf_data_{file_hash}"
            if cache.has(cache_key):
                cache.delete(cache_key)
                app.logger.info(f"已清除Flask缓存: {cache_key}")
                
            # 2. 清除文件系统缓存
            cache_dir = os.path.join(app.config['PASSPORTS_FOLDER'], 'cache')
            cache_file = os.path.join(cache_dir, f"{file_hash}_processed.json")
            if os.path.exists(cache_file):
                os.remove(cache_file)
                app.logger.info(f"已清除文件缓存: {cache_file}")
                
            # 3. 清除文本缓存
            text_cache_file = os.path.join(cache_dir, f"{file_hash}_text.json")
            if os.path.exists(text_cache_file):
                os.remove(text_cache_file)
                app.logger.info(f"已清除文本缓存: {text_cache_file}")
        
        return jsonify({
            'message': '护照文件上传成功',
            'pdf_filename': filename,
            'is_new_file': is_new_file
        })
        
    except Exception as e:
        app.logger.error(f'护照上传失败: {str(e)}', exc_info=True)
        return jsonify({'error': str(e)}), 500

def process_page(page_num, text, coze_handler):
    """处理单个页面的函数"""
    try:
        passport_data = coze_handler.process_passport_text(text)
        if passport_data and coze_handler.validate_response(passport_data):
            passport_data['page_number'] = page_num + 1  # 转换为1开始的页码
            return passport_data
    except Exception as e:
        logger.error(f'处理第 {page_num + 1} 页时出错: {str(e)}')
    return None

@app.route('/preprocess/passport', methods=['POST'])
def preprocess_passport():
    try:
        data = request.get_json()
        if not data or 'pdf_filename' not in data:
            return jsonify({'error': '缺少文件名'}), 400
            
        filename = data['pdf_filename']
        filepath = os.path.join(app.config['PASSPORTS_FOLDER'], filename)
        
        if not os.path.exists(filepath):
            return jsonify({'error': '文件不存在'}), 404
        
        # 是否强制重新处理，忽略缓存
        force_reprocess = data.get('force_reprocess', False)
        
        # 提取文件哈希值（从文件名中获取）
        file_hash = filename.split('.')[0]
            
        # 检查Flask缓存是否存在
        cache_key = f"pdf_processed_{file_hash}"
        cached_data = None
        
        if not force_reprocess:
            # 1. 首先检查Flask缓存
            if cache.has(cache_key):
                cached_data = cache.get(cache_key)
                logger.info(f"从Flask缓存获取到处理结果: {cache_key}")
            
            # 2. 如果Flask缓存不存在，检查文件系统缓存
            if not cached_data:
                cache_dir = os.path.join(app.config['PASSPORTS_FOLDER'], 'cache')
                os.makedirs(cache_dir, exist_ok=True)
                cache_file = os.path.join(cache_dir, f"{file_hash}_processed.json")
                
                if os.path.exists(cache_file):
                    try:
                        with open(cache_file, 'r', encoding='utf-8') as f:
                            cached_data = json.load(f)
                            logger.info(f"从文件缓存获取到处理结果: {cache_file}")
                            
                            # 将文件缓存同步到Flask缓存以加速未来访问
                            cache.set(cache_key, cached_data)
                    except Exception as e:
                        logger.error(f"读取缓存文件失败: {str(e)}")
                        # 如果读取损坏，删除损坏的缓存文件
                        try:
                            os.remove(cache_file)
                            logger.info(f"已删除损坏的缓存文件: {cache_file}")
                        except:
                            pass
        
        # 验证缓存数据是否有效
        if cached_data and not force_reprocess:
            passport_data_list = cached_data.get('passport_data_list')
            if passport_data_list and isinstance(passport_data_list, list) and len(passport_data_list) > 0:
                # 进一步验证护照数据的结构
                valid_data = True
                for passport_data in passport_data_list:
                    if not isinstance(passport_data, dict) or 'passport_number' not in passport_data:
                        valid_data = False
                        break
                
                if valid_data:
                    # 返回缓存数据，但使用流式响应格式以保持一致性
                    def generate_cached():
                        yield json.dumps({
                            'status': '从缓存加载数据...',
                            'progress': 50
                        }) + '\n'
                        
                        yield json.dumps({
                            'status': '加载完成',
                            'progress': 100,
                            'passport_data_list': passport_data_list,
                            'valid_pages': cached_data['valid_pages'],
                            'from_cache': True
                        }) + '\n'
                    
                    return app.response_class(
                        generate_cached(),
                        mimetype='text/event-stream'
                    )
                else:
                    logger.warning(f"缓存数据验证失败，将重新处理")
        
        def generate():
            try:
                # 初始化 PDF 处理器
                pdf_handler = PDFHandler(filepath, cache=cache)
                total_pages = pdf_handler.get_page_count()
                
                yield json.dumps({
                    'status': '正在初始化...',
                    'progress': 0
                }) + '\n'
                
                # 获取所有页面的文本
                all_texts = pdf_handler.get_all_texts()
                
                yield json.dumps({
                    'status': '成功提取文本',
                    'progress': 20
                }) + '\n'
                
                # 初始化 CozeHandler
                coze_handler = CozeHandler(app.config['COZE_API_KEY'], app.config['COZE_BOT_ID'])
                
                # 处理所有页面的文本
                passport_data_list = []
                valid_pages = []
                processed_count = 0
                total_count = len(all_texts)
                
                # 创建任务列表
                futures = []
                for page_num, text in all_texts.items():
                    future = executor.submit(process_page, int(page_num), text, coze_handler)
                    futures.append((int(page_num), future))
                
                # 处理完成的任务结果
                for page_num, future in futures:
                    try:
                        passport_data = future.result()
                        processed_count += 1
                        progress = 20 + (processed_count * 70 // total_count)
                        
                        with progress_lock:
                            yield json.dumps({
                                'status': f'正在处理第 {page_num + 1} 页... ({processed_count}/{total_count})',
                                'progress': progress
                            }) + '\n'
                        
                        if passport_data:
                            passport_data_list.append(passport_data)
                            valid_pages.append(page_num + 1)
                            
                    except Exception as e:
                        logger.error(f'处理第 {page_num + 1} 页时出错: {str(e)}')
                        continue
                
                if not passport_data_list:
                    yield json.dumps({
                        'status': '未能提取到有效的护照信息',
                        'progress': 100,
                        'error': '未能从任何页面提取到完整的护照信息'
                    }) + '\n'
                    return
                
                # 保存处理结果到缓存
                cache_data = {
                    'file_hash': file_hash,
                    'passport_data_list': passport_data_list,
                    'total_pages': total_pages,
                    'valid_pages': valid_pages,
                    'processed_time': time.strftime('%Y-%m-%d %H:%M:%S')
                }
                
                # 保存到Flask缓存
                cache.set(cache_key, cache_data)
                logger.info(f"已保存处理结果到Flask缓存: {cache_key}")
                
                # 保存到文件缓存
                cache_dir = os.path.join(app.config['PASSPORTS_FOLDER'], 'cache')
                os.makedirs(cache_dir, exist_ok=True)
                cache_file = os.path.join(cache_dir, f"{file_hash}_processed.json")
                
                with open(cache_file, 'w', encoding='utf-8') as f:
                    json.dump(cache_data, f, ensure_ascii=False, indent=2)
                logger.info(f"已保存处理结果到文件缓存: {cache_file}")
                
                yield json.dumps({
                    'status': '处理完成',
                    'progress': 100,
                    'passport_data_list': passport_data_list,
                    'valid_pages': valid_pages
                }) + '\n'
                
            except Exception as e:
                logger.error(f'预处理失败: {str(e)}', exc_info=True)
                yield json.dumps({
                    'status': '处理失败',
                    'progress': 100,
                    'error': str(e)
                }) + '\n'
        
        return app.response_class(
            generate(),
            mimetype='text/event-stream'
        )
        
    except Exception as e:
        logger.error(f'预处理失败: {str(e)}', exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/upload/photos', methods=['POST'])
def upload_photos():
    try:
        if 'files[]' not in request.files:
            return jsonify({'error': '没有文件上传'}), 400
        
        files = request.files.getlist('files[]')
        if not files or all(not f.filename for f in files):
            return jsonify({'error': '没有选择文件'}), 400
        
        uploaded_files = []
        errors = []
        total_size = 0
        
        # 首先检查所有文件的总大小
        for file in files:
            if not file.filename:
                continue
            file.seek(0, os.SEEK_END)
            total_size += file.tell()
            file.seek(0)
        
        if total_size > app.config['MAX_CONTENT_LENGTH']:
            return jsonify({
                'error': f'文件总大小超过限制，最大允许 {app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)}MB'
            }), 413
        
        # 确保上传目录存在
        os.makedirs(app.config['PHOTOS_FOLDER'], exist_ok=True)
        
        for file in files:
            if not file.filename:
                continue
                
            if not allowed_file(file.filename, 'photo'):
                errors.append(f"文件 {file.filename} 类型不支持")
                continue
            
            if not check_file_size(file, 'photo'):
                errors.append(f"文件 {file.filename} 超过大小限制 {app.config['MAX_FILE_SIZE']['photo'] // (1024 * 1024)}MB")
                continue
                
            try:
                # 直接使用原始文件名，只清理不安全的字符
                filename = secure_filename(os.path.basename(file.filename))
                filepath = os.path.join(app.config['PHOTOS_FOLDER'], filename)
                
                # 如果文件已存在，先删除它
                if os.path.exists(filepath):
                    os.remove(filepath)
                
                file.save(filepath)
                uploaded_files.append(filename)
                app.logger.debug(f'成功保存照片: {filename} -> {filepath}')
            except Exception as e:
                app.logger.error(f'保存照片失败: {filename}, 错误: {str(e)}')
                errors.append(f"文件 {file.filename} 上传失败: {str(e)}")
        
        if not uploaded_files and errors:
            return jsonify({
                'error': '所有文件上传失败',
                'details': errors
            }), 400
            
        return jsonify({
            'message': f'成功上传 {len(uploaded_files)} 个文件',
            'uploaded_files': uploaded_files,
            'errors': errors if errors else None
        })
    except Exception as e:
        app.logger.error(f'照片上传过程发生错误: {str(e)}')
        return jsonify({
            'error': '上传过程中发生错误',
            'details': str(e)
        }), 500

def get_request_cache_key():
    """生成适合缓存键的请求唯一标识符"""
    args_hash = hashlib.md5(json.dumps(request.args, sort_keys=True).encode()).hexdigest()
    path = request.path
    method = request.method
    
    # 添加请求体的哈希值（如果存在）
    data_hash = ""
    if request.is_json and request.data:
        data_hash = hashlib.md5(request.data).hexdigest()
    elif request.form:
        data_hash = hashlib.md5(json.dumps(request.form, sort_keys=True).encode()).hexdigest()
    
    return f"{method}:{path}:{args_hash}:{data_hash}"

@app.route('/api/compare', methods=['POST'])
@cache.memoize(timeout=60 * 30)  # 缓存30分钟
def compare_data():
    try:
        data = request.json
        if not data:
            return jsonify({'error': '没有提供数据'}), 400
            
        csv_index = data.get('csv_index')
        passport_data = data.get('passport_data')
        
        if csv_index is None or passport_data is None:
            return jsonify({'error': '缺少必要的比较数据'}), 400
        
        csv_handler = CSVHandler(os.path.join(app.config['CSV_FOLDER'], 'current.csv'), cache=cache)
        comparison_result = csv_handler.compare_with_passport_data(csv_index, passport_data)
        
        return jsonify({
            'message': '数据比较完成',
            'result': comparison_result
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/uploads/photos/<filename>')
def photo_file(filename):
    # 添加调试日志
    app.logger.debug(f'请求照片文件: {filename}')
    app.logger.debug(f'照片文件夹路径: {app.config["PHOTOS_FOLDER"]}')
    full_path = os.path.join(app.config['PHOTOS_FOLDER'], filename)
    app.logger.debug(f'完整文件路径: {full_path}')
    app.logger.debug(f'文件是否存在: {os.path.exists(full_path)}')
    
    if not os.path.exists(full_path):
        app.logger.error(f'照片文件不存在: {full_path}')
        return jsonify({'error': '照片文件不存在'}), 404
        
    try:
        return send_from_directory(app.config['PHOTOS_FOLDER'], filename)
    except Exception as e:
        app.logger.error(f'发送文件失败: {str(e)}')
        return jsonify({'error': str(e)}), 500

@app.route('/uploads/passports/<filename>')
def passport_file(filename):
    return send_from_directory(app.config['PASSPORTS_FOLDER'], filename)

@app.route('/recheck/errors', methods=['POST'])
def recheck_errors():
    try:
        data = request.get_json()
        if not data or 'pdf_filename' not in data or 'records' not in data:
            return jsonify({'error': '缺少必要参数'}), 400

        pdf_filename = data['pdf_filename']
        records = data['records']

        if not os.path.exists(os.path.join(app.config['PASSPORTS_FOLDER'], pdf_filename)):
            return jsonify({'error': 'PDF文件不存在'}), 404

        # 初始化处理器
        pdf_handler = PDFHandler(os.path.join(app.config['PASSPORTS_FOLDER'], pdf_filename), cache=cache)
        coze_handler = CozeHandler(app.config['COZE_API_KEY'], app.config['COZE_BOT_ID'])
        
        updated_records = []
        
        for record in records:
            try:
                # 获取护照页面文本
                if record['page_number'] is not None:
                    # 对于已找到护照首页的记录,使用指定页面
                    page_text = pdf_handler.get_text(record['page_number'] - 1)  # PDF页码从0开始
                else:
                    # 对于未找到护照首页的记录,遍历所有页面寻找匹配
                    page_text = None
                    for page_num in range(pdf_handler.get_page_count()):
                        text = pdf_handler.get_text(page_num)
                        # 检查文本中是否包含护照号码
                        if record['passport_number'] in text:
                            page_text = text
                            record['page_number'] = page_num + 1  # 转换为1开始的页码
                            break
                
                if page_text:
                    # 使用 Coze API 重新识别护照信息
                    passport_data = coze_handler.process_passport_text(page_text)
                    if passport_data:
                        # 添加页码信息
                        passport_data['page_number'] = record['page_number']
                        updated_records.append(passport_data)
                        
                        # 更新缓存
                        cache_key = f"passport_data_{pdf_filename}"
                        cached_data = cache.get(cache_key)
                        if cached_data:
                            # 更新或添加新记录
                            index = next((i for i, p in enumerate(cached_data['passport_data_list']) 
                                        if p['passport_number'] == passport_data['passport_number']), -1)
                            if index != -1:
                                cached_data['passport_data_list'][index] = passport_data
                            else:
                                cached_data['passport_data_list'].append(passport_data)
                            cache.set(cache_key, cached_data)
            except Exception as e:
                logger.error(f"处理记录时出错: {str(e)}", exc_info=True)
                continue

        return jsonify({
            'message': '复核完成',
            'updated_records': updated_records
        })

    except Exception as e:
        logger.error(f"复核错误: {str(e)}", exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/get_passport_data/<filename>', methods=['GET'])
@cache.cached(timeout=60 * 60, key_prefix=lambda: f"passport_data_{request.view_args['filename']}")
def get_passport_data(filename):
    try:
        filepath = os.path.join(app.config['PASSPORTS_FOLDER'], filename)
        if not os.path.exists(filepath):
            return jsonify({'error': '文件不存在'}), 404
            
        pdf_handler = PDFHandler(filepath, cache=cache)
        passport_data = pdf_handler.extract_passport_data()
        
        return jsonify({
            'message': '获取护照数据成功',
            'data': passport_data
        })
    except Exception as e:
        logger.error(f"获取护照数据失败: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/get_acceptance_numbers', methods=['GET'])
@cache.cached(timeout=60 * 10)  # 缓存10分钟
def get_acceptance_numbers():
    """获取所有受理号列表，用于前期核对"""
    try:
        # 获取CSV文件路径
        csv_files = [f for f in os.listdir(app.config['CSV_FOLDER']) if f.endswith('.csv')]
        if not csv_files:
            return jsonify({'error': '未找到CSV文件'}), 404
            
        # 使用最新的CSV文件或指定文件
        current_csv = request.args.get('file', 'current.csv')
        if current_csv not in csv_files and 'current.csv' in csv_files:
            current_csv = 'current.csv'
        elif current_csv not in csv_files and csv_files:
            current_csv = csv_files[0]
            
        csv_path = os.path.join(app.config['CSV_FOLDER'], current_csv)
        csv_handler = CSVHandler(csv_path, cache=cache)
        
        # 获取所有记录
        records = csv_handler.to_json()
        
        # 提取受理号和中文姓名
        acceptance_numbers = []
        for idx, record in enumerate(records):
            acceptance_numbers.append({
                'index': idx,
                'acceptance_number': record.get('index', ''),
                'chinese_name': record.get('chinese_name', ''),
                'passport_number': record.get('passport_number', ''),
                'team_acceptance_number': record.get('team_acceptance_number', '')
            })
            
        return jsonify({
            'message': '获取受理号列表成功',
            'data': acceptance_numbers,
            'file': current_csv
        })
    except Exception as e:
        logger.error(f"获取受理号列表失败: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/clear_cache', methods=['POST'])
def clear_cache():
    try:
        cleared_items = []
        
        # 1. 清除Flask内存缓存
        if hasattr(cache, 'clear'):
            cache.clear()
            cleared_items.append('Flask缓存')
            logger.info("已清除Flask缓存")
        
        # 2. 清除所有上传目录中的文件
        upload_dirs = [
            app.config['CSV_FOLDER'],
            app.config['PHOTOS_FOLDER'],
            app.config['PASSPORTS_FOLDER']
        ]
        
        for dir_path in upload_dirs:
            if os.path.exists(dir_path):
                files_removed = 0
                for filename in os.listdir(dir_path):
                    file_path = os.path.join(dir_path, filename)
                    try:
                        if os.path.isfile(file_path):
                            os.remove(file_path)
                            files_removed += 1
                    except Exception as e:
                        logger.error(f"删除文件失败: {filename}, 错误: {str(e)}")
                
                if files_removed > 0:
                    dir_name = os.path.basename(dir_path)
                    cleared_items.append(f"{dir_name}目录({files_removed}个文件)")
                logger.info(f"已从{dir_path}中删除 {files_removed} 个文件")
        
        # 3. 清除所有缓存目录
        cache_dirs = [
            os.path.join(app.config['PASSPORTS_FOLDER'], 'cache'),  # 护照缓存目录
            os.path.join(app.config['BASE_DIR'], 'cache'),          # 基础缓存目录
            os.path.join(app.config['BASE_DIR'], 'uploads/cache')   # uploads缓存目录
        ]
        
        for cache_dir in cache_dirs:
            if os.path.exists(cache_dir):
                files_removed = 0
                for filename in os.listdir(cache_dir):
                    file_path = os.path.join(cache_dir, filename)
                    try:
                        if os.path.isfile(file_path):
                            os.remove(file_path)
                            files_removed += 1
                    except Exception as e:
                        logger.error(f"删除缓存文件失败: {filename}, 错误: {str(e)}")
                
                if files_removed > 0:
                    dir_name = os.path.basename(os.path.dirname(cache_dir))
                    cleared_items.append(f"{dir_name}缓存({files_removed}个文件)")
                logger.info(f"已从缓存目录中删除 {files_removed} 个文件")
                
                # 尝试删除空的缓存目录
                try:
                    if not os.listdir(cache_dir):  # 如果目录为空
                        os.rmdir(cache_dir)        # 删除空目录
                        logger.info(f"已删除空的缓存目录: {cache_dir}")
                except Exception as e:
                    logger.error(f"删除空缓存目录失败: {cache_dir}, 错误: {str(e)}")
        
        # 4. 清除日志目录
        logs_dir = os.path.join(app.config['BASE_DIR'], 'logs')
        if os.path.exists(logs_dir):
            files_removed = 0
            for filename in os.listdir(logs_dir):
                if filename.endswith('.log'):
                    file_path = os.path.join(logs_dir, filename)
                    try:
                        os.remove(file_path)
                        files_removed += 1
                    except Exception as e:
                        logger.error(f"删除日志文件失败: {filename}, 错误: {str(e)}")
            
            if files_removed > 0:
                cleared_items.append(f"日志文件({files_removed}个)")
            logger.info(f"已从日志目录中删除 {files_removed} 个文件")
        
        # 构建清理结果消息
        if cleared_items:
            message = '已清除：' + '、'.join(cleared_items)
        else:
            message = '没有需要清除的数据'
            
        return jsonify({
            'success': True,
            'message': message
        })
        
    except Exception as e:
        logger.error(f"清除缓存失败: {str(e)}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/check_cache', methods=['POST'])
def check_cache():
    try:
        data = request.get_json()
        if not data or 'pdf_filename' not in data:
            return jsonify({'error': '缺少文件名'}), 400
            
        filename = data['pdf_filename']
        file_hash = filename.split('.')[0]  # 从文件名中提取哈希值
        
        # 检查是否存在有效的缓存
        has_cache = False
        
        # 1. 检查Flask缓存
        cache_key = f"pdf_processed_{file_hash}"
        if cache.has(cache_key):
            cached_data = cache.get(cache_key)
            if cached_data and 'passport_data_list' in cached_data:
                has_cache = True
                logger.info(f"在Flask缓存中找到数据: {cache_key}")
        
        # 2. 如果Flask缓存不存在，检查文件系统缓存
        if not has_cache:
            cache_dir = os.path.join(app.config['PASSPORTS_FOLDER'], 'cache')
            cache_file = os.path.join(cache_dir, f"{file_hash}_processed.json")
            
            if os.path.exists(cache_file):
                try:
                    with open(cache_file, 'r', encoding='utf-8') as f:
                        cached_data = json.load(f)
                        if cached_data and 'passport_data_list' in cached_data:
                            has_cache = True
                            logger.info(f"在文件系统缓存中找到数据: {cache_file}")
                except Exception as e:
                    logger.error(f"读取缓存文件失败: {str(e)}")
                    # 如果缓存文件损坏，删除它
                    try:
                        os.remove(cache_file)
                        logger.info(f"已删除损坏的缓存文件: {cache_file}")
                    except:
                        pass
        
        return jsonify({
            'success': True,
            'has_cache': has_cache
        })
        
    except Exception as e:
        logger.error(f"检查缓存失败: {str(e)}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False) 